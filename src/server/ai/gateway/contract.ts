/**
 * The Model Gateway's normalised contract (P1-B).
 *
 * Everything above the gateway speaks these types; everything provider-specific
 * lives in `adapters/`. Requests are parsed with zod at the boundary, and every
 * adapter result is parsed again before it leaves the adapter, so a provider
 * that changes a field cannot push an unexpected shape into the application.
 *
 * Domain-neutral on purpose: nothing here knows about projects, graphs or
 * statistics. The gateway carries ids for metering, not meaning.
 */

import { z } from 'zod';

export const PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Cost and entitlement class of a model; see `routing.ts`. */
export const MODEL_CLASSES = ['economy', 'standard', 'premium'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const REQUEST_KINDS = ['generate', 'stream', 'structured', 'tools', 'embed'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/* ------------------------------- Content --------------------------------- */

export const textPart = z.object({ type: z.literal('text'), text: z.string() });
export const imagePart = z.object({
  type: z.literal('image'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  /** Base64, without a data: prefix. */
  data: z.string().min(1).max(8_000_000),
});
export const toolCallPart = z.object({
  type: z.literal('tool_call'),
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
});
export const toolResultPart = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
  /** Serialised result given back to the model. Untrusted data, never instructions. */
  content: z.string().max(200_000),
  isError: z.boolean().default(false),
});

export const contentPart = z.discriminatedUnion('type', [textPart, imagePart, toolCallPart, toolResultPart]);
export type ContentPart = z.infer<typeof contentPart>;

export const message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentPart).min(1)]),
});
export type GatewayMessage = z.infer<typeof message>;

/* -------------------------------- Tools ---------------------------------- */

/**
 * A tool the model may call. `parameters` is the JSON Schema sent to the
 * provider; `validate` is the zod schema the arguments must satisfy before
 * anything treats them as data. Both come from one zod definition (`tools.ts`).
 */
export interface GatewayTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  validate: z.ZodType<Record<string, unknown>>;
}

export type ToolChoice = 'auto' | 'required' | 'none' | { name: string };

/* ------------------------------- Request --------------------------------- */

export const requestSchema = z.object({
  /** What the call is for: an `AITask` or a capability id. Metadata, not routing input. */
  purpose: z.string().min(1).max(64),
  system: z.string().max(400_000).default(''),
  messages: z.array(message).min(1).max(400),
  maxOutputTokens: z.number().int().positive().max(64_000).default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  /** false: least deliberation the model offers; undefined: provider default. */
  reasoning: z.boolean().optional(),
  cacheSystem: z.boolean().default(true),
  /** The user's explicit choice, already checked against their plan by the caller. */
  requested: z.object({ provider: z.enum(PROVIDERS), model: z.string().min(1).max(100) }).nullish(),
  /** Hints for routing (see `routing.ts`). */
  needsReasoning: z.boolean().default(true),
  latencySensitive: z.boolean().default(false),
  /** A caller may shorten the policy timeout, never lengthen it. */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * How the call counts against the plan (`quota.ts`): a user-visible
   * generation is one request; an internal step (classification, planning, a
   * continuation round) is metered but not counted as a request.
   */
  countsAsRequest: z.boolean().default(true),
  /** Words the call is expected to produce, for the reservation. */
  estimatedWords: z.number().int().nonnegative().optional(),
  /** Makes the quota reservation idempotent across retries of the same step. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type GatewayRequestInput = z.input<typeof requestSchema>;
export type GatewayRequest = z.output<typeof requestSchema>;

/* ------------------------------- Response -------------------------------- */

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** True when the provider reported nothing and the numbers are our estimate. */
  estimated: z.boolean().default(false),
});
export type Usage = z.infer<typeof usageSchema>;

export const FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'error', 'cancelled'] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

/** What an adapter returns for one attempt. Parsed before it leaves the adapter. */
export const adapterResultSchema = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      /** Parsed JSON if it parsed; the raw string otherwise (then rejected upstream). */
      arguments: z.unknown(),
    }),
  ),
  finishReason: z.enum(FINISH_REASONS),
  usage: usageSchema,
  model: z.string().min(1),
});
export type AdapterResult = z.infer<typeof adapterResultSchema>;

export interface ValidatedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface RoutingDecision {
  tier: 'free' | 'paid' | 'admin';
  requested: { provider: Provider; model: string } | null;
  chosen: { provider: Provider; model: string; modelClass: ModelClass };
  /** Allowed substitutes, in order, all within the entitlement. */
  fallbacks: { provider: Provider; model: string; modelClass: ModelClass }[];
  reason: string;
}

export interface GatewayResponse {
  callId: string;
  text: string;
  toolCalls: ValidatedToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  provider: Provider;
  model: string;
  latencyMs: number;
  attempts: number;
  routing: RoutingDecision;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'notice'; notice: 'retry' | 'failover' }
  | { type: 'done'; response: GatewayResponse };

/* ------------------------------ Embeddings ------------------------------- */

export const embedRequestSchema = z.object({
  purpose: z.string().min(1).max(64),
  inputs: z.array(z.string().min(1).max(32_000)).min(1).max(256),
  requested: z.object({ provider: z.enum(PROVIDERS), model: z.string().min(1).max(100) }).nullish(),
  timeoutMs: z.number().int().positive().optional(),
});
export type EmbedRequestInput = z.input<typeof embedRequestSchema>;

export interface EmbedResponse {
  callId: string;
  vectors: number[][];
  provider: Provider;
  model: string;
  usage: Usage;
}
