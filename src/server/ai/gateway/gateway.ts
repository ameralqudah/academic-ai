/**
 * The Model Gateway (P1-B): the only path from Academic AI to a model.
 *
 * Every call:
 *   1. is parsed against the normalised contract;
 *   2. is tied to a user (fail closed: no user in scope, no call) and, when it
 *      names a project, to a project the user may see;
 *   3. is routed within the user's entitlement, looked up here from the user
 *      id — never carried in a payload, so a worker cannot lose it;
 *   4. reserves its quota before any provider is contacted;
 *   5. runs within a hard timeout, a bounded attempt budget and a failover
 *      order that never leaves the entitlement or raises the model class;
 *   6. leaves a durable usage row per attempt, whatever happened;
 *   7. commits actual usage to the quota ledger, or releases the reservation.
 *
 * Dependencies are injected so the whole lifecycle is tested deterministically
 * (`scripts/gateway.ts`) and against PostgreSQL (`scripts/gateway-integration.ts`).
 */

import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import { estimateTokens } from '@/ai/provider';
import { logger } from '@/lib/logger';

import type { AdapterCall, ProviderAdapter } from './adapters/types';
import {
  embedRequestSchema,
  requestSchema,
  type AdapterResult,
  type EmbedRequestInput,
  type EmbedResponse,
  type GatewayRequest,
  type GatewayRequestInput,
  type GatewayResponse,
  type GatewayTool,
  type ModelClass,
  type Provider,
  type RequestKind,
  type RoutingDecision,
  type StreamEvent,
  type ToolChoice,
  type Usage,
  type ValidatedToolCall,
} from './contract';
import { classifyThrown, GatewayError } from './errors';
import { attemptCost, type Meter } from './metering';
import { backoffMs, nextTarget, shouldRetry, STREAM_IDLE_MS, timeoutFor, type Clock } from './policy';
import type { Reservation, ReserveInput } from './quota';
import { modelClass, route, type ConfiguredModel, type Tier } from './routing';
import { offeredTools, validateToolCalls, type RejectedToolCall } from './tools';

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

export interface CallScope {
  userId: string;
  projectId?: string | null;
  taskId?: string | null;
  jobId?: string | null;
  runId?: string | null;
}

export interface PlanInfo {
  tier: Tier;
  limits: { maxAiRequests: number; maxGeneratedWords: number };
  unlimited: (limit: number) => boolean;
}

export interface GatewayDeps {
  adapters(): Partial<Record<Provider, ProviderAdapter>>;
  models(): Promise<{ configured: ConfiguredModel[]; defaultProvider: Provider; siblings: Partial<Record<Provider, string>> }>;
  plan(userId: string): Promise<PlanInfo>;
  checkProject(projectId: string, userId: string): Promise<void>;
  quota: {
    reserve(input: ReserveInput): Promise<Reservation>;
    commit(input: import('./quota').CommitInput): Promise<void>;
    release(reservation: Reservation): Promise<void>;
  };
  meter: Meter;
  clock: Clock;
  scope(): CallScope | null;
  notify(notice: 'retry' | 'failover'): void;
}

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface CallOptions {
  signal?: AbortSignal;
  /**
   * Ids for this call on top of the scope's (a streamed generator runs in its
   * caller's async context, so a call site can name its project here). The
   * user always comes from the scope; a project named here is authorised
   * against that user like any other.
   */
  ids?: { projectId?: string | null; taskId?: string | null; jobId?: string | null; runId?: string | null };
  /** Timeout class for long-form rounds, which may run longer than a plain generation. */
  timeoutKind?: 'longForm';
}

export interface ToolCallOptions extends CallOptions {
  tools: GatewayTool[];
  /** Tool names this run is permitted to use (from the run's policy). */
  permittedTools: Iterable<string>;
  toolChoice?: ToolChoice;
}

export interface ToolCallResponse extends GatewayResponse {
  rejectedToolCalls: RejectedToolCall[];
  /** ai_tool_calls row id per provider tool call id, for `recordToolExecution`. */
  toolCallRecords: Record<string, string>;
}

interface Prepared {
  callId: string;
  kind: RequestKind;
  request: GatewayRequest;
  scope: CallScope;
  decision: RoutingDecision;
  reservation: Reservation;
  startedAt: number;
}

interface AttemptLog {
  usage: Usage;
  cost: number;
}

type Target = { provider: Provider; model: string; modelClass: ModelClass };

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false };

function inputText(request: GatewayRequest): string {
  const parts = request.messages.flatMap((m) =>
    typeof m.content === 'string' ? [m.content] : m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')),
  );
  return [request.system, ...parts].join('\n');
}

function sumUsage(logs: AttemptLog[]): Usage {
  return logs.reduce<Usage>(
    (acc, log) => ({
      inputTokens: acc.inputTokens + log.usage.inputTokens,
      outputTokens: acc.outputTokens + log.usage.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + log.usage.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + log.usage.cacheWriteTokens,
      estimated: acc.estimated || log.usage.estimated,
    }),
    { ...ZERO_USAGE },
  );
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

/* -------------------------------------------------------------------------- */
/*                                  Gateway                                   */
/* -------------------------------------------------------------------------- */

export function createGateway(deps: GatewayDeps) {
  async function prepare(kind: RequestKind, input: GatewayRequestInput, options: CallOptions): Promise<Prepared> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayError('invalid_request', `Invalid gateway request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const request = parsed.data;
    const base = deps.scope();
    const scope = base ? { ...base, ...Object.fromEntries(Object.entries(options.ids ?? {}).filter(([, v]) => v)) } : null;
    if (!scope?.userId) {
      throw new GatewayError('internal', 'A model call was made outside a user scope; refused rather than routed as anonymous.');
    }
    if (options.signal?.aborted) throw new GatewayError('cancelled', 'The request was cancelled.');
    if (scope.projectId) await deps.checkProject(scope.projectId, scope.userId);

    let plan: PlanInfo;
    try {
      plan = await deps.plan(scope.userId);
    } catch (error) {
      /* Fail closed: without a plan there is no entitlement and no quota to reserve against. */
      throw new GatewayError('internal', 'The plan could not be resolved; the call is refused.', { detail: String(error) });
    }

    const { configured, defaultProvider, siblings } = await deps.models();
    const available = deps.adapters();
    const usable = configured.filter((m) => available[m.provider]?.configured());
    const contextTokens = estimateTokens(inputText(request));
    const decision = route({
      tier: plan.tier,
      configured: usable,
      defaultProvider,
      requested: request.requested ?? null,
      needsReasoning: request.needsReasoning,
      latencySensitive: request.latencySensitive,
      contextTokens,
      siblingModels: siblings,
    });

    const window = available[decision.chosen.provider]!.capabilities(decision.chosen.model).contextTokens;
    if (contextTokens + request.maxOutputTokens > window) {
      throw new GatewayError('context_length', 'The request is too long for the model.', {
        provider: decision.chosen.provider,
        detail: `estimated ${contextTokens} input + ${request.maxOutputTokens} output > ${window}`,
      });
    }

    const callId = randomUUID();
    const reservation = await deps.quota.reserve({
      userId: scope.userId,
      idempotencyKey: request.idempotencyKey ?? callId,
      requests: request.countsAsRequest ? 1 : 0,
      words: request.estimatedWords ?? 0,
      continuation: request.continuation,
      limits: plan.limits,
      unlimited: plan.unlimited,
    });

    logger.info('ai.gateway.request', {
      callId,
      kind,
      purpose: request.purpose,
      userId: scope.userId,
      projectId: scope.projectId ?? null,
      taskId: scope.taskId ?? null,
      jobId: scope.jobId ?? null,
    });
    logger.info('ai.gateway.route', { callId, ...decision });

    return { callId, kind, request, scope, decision, reservation, startedAt: deps.clock.now() };
  }

  async function record(
    prepared: Prepared,
    attempt: number,
    target: Target,
    outcome: { status: 'succeeded' | 'failed' | 'cancelled'; usage: Usage; errorClass?: string; finishReason?: string; latencyMs: number },
    logs: AttemptLog[],
  ) {
    const cost = attemptCost(target.model, outcome.usage);
    logs.push({ usage: outcome.usage, cost });
    logger.info('ai.gateway.attempt', {
      callId: prepared.callId,
      attempt,
      provider: target.provider,
      model: target.model,
      status: outcome.status,
      errorClass: outcome.errorClass ?? null,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
    });
    await deps.meter
      .attempt({
        callId: prepared.callId,
        attempt,
        userId: prepared.scope.userId,
        projectId: prepared.scope.projectId ?? null,
        taskId: prepared.scope.taskId ?? null,
        jobId: prepared.scope.jobId ?? null,
        runId: prepared.scope.runId ?? null,
        purpose: prepared.request.purpose,
        kind: prepared.kind,
        provider: target.provider,
        model: target.model,
        modelClass: target.modelClass,
        status: outcome.status,
        errorClass: outcome.errorClass ?? null,
        finishReason: outcome.finishReason ?? null,
        usage: outcome.usage,
        costMicroUsd: cost,
        latencyMs: outcome.latencyMs,
        routing: prepared.decision,
        reservationId: prepared.reservation.id || null,
      })
      .catch((error: unknown) => {
        /* A metering failure is loud but must not turn a delivered answer into an error. */
        logger.error('ai.gateway.meterFailed', { callId: prepared.callId, error: String(error).slice(0, 200) });
      });
  }

  /** Settles the reservation from what actually happened. */
  async function settle(prepared: Prepared, logs: AttemptLog[], result: { text: string; target: Target } | null, countsAsRequest: boolean) {
    const usage = sumUsage(logs);
    const consumed = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;
    try {
      if (!result && !consumed) {
        await deps.quota.release(prepared.reservation);
        return;
      }
      const target = result?.target ?? prepared.decision.chosen;
      await deps.quota.commit({
        reservation: prepared.reservation,
        countsAsRequest: Boolean(result) && countsAsRequest,
        outputText: result?.text ?? '',
        projectId: prepared.scope.projectId ?? null,
        provider: target.provider,
        model: target.model,
        tokensIn: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        tokensOut: usage.outputTokens,
        costMicroUsd: logs.reduce((sum, log) => sum + log.cost, 0),
      });
    } catch (error) {
      logger.error('ai.gateway.settleFailed', { callId: prepared.callId, error: String(error).slice(0, 200) });
    }
  }

  function adapterFor(target: Target): ProviderAdapter {
    const adapter = deps.adapters()[target.provider];
    if (!adapter?.configured()) throw new GatewayError('not_configured', `${target.provider} is not configured.`, { provider: target.provider });
    return adapter;
  }

  function signalFor(timeoutMs: number, caller?: AbortSignal, extra?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(caller ? [caller] : []), ...(extra ? [extra] : [])]);
  }

  function reclassify(target: Target, error: unknown, caller?: AbortSignal): GatewayError {
    if (caller?.aborted) return new GatewayError('cancelled', 'The request was cancelled.', { provider: target.provider });
    return classifyThrown(target.provider, error, false);
  }

  /** Runs one logical non-streaming call within the attempt budget. */
  async function execute(
    kind: RequestKind,
    input: GatewayRequestInput,
    options: CallOptions,
    extra: Omit<AdapterCall, 'request' | 'model' | 'signal'> = {},
  ): Promise<{ prepared: Prepared; result: AdapterResult; target: Target; attempts: number; logs: AttemptLog[] }> {
    const prepared = await prepare(kind, input, options);
    const logs: AttemptLog[] = [];
    const timeout = timeoutFor(options.timeoutKind ?? kind, prepared.request.timeoutMs);
    const primary = prepared.decision.chosen;
    const fallback = prepared.decision.fallbacks[0];
    let lastError: GatewayError | undefined;

    try {
      for (let attempt = 1; ; attempt += 1) {
        const target = nextTarget(attempt, primary, fallback);
        if (!target) break;
        if (attempt > 1) {
          deps.notify(target === primary ? 'retry' : 'failover');
          logger.warn(target === primary ? 'ai.gateway.retry' : 'ai.gateway.failover', {
            callId: prepared.callId,
            attempt,
            to: `${target.provider}:${target.model}`,
            errorClass: lastError?.errorClass,
          });
          const wait = backoffMs(attempt, lastError!, deps.clock, target === primary);
          if (wait > 0) {
            await deps.clock.sleep(wait, options.signal).catch(() => {
              throw new GatewayError('cancelled', 'The request was cancelled.');
            });
          }
        }
        const started = deps.clock.now();
        try {
          const adapter = adapterFor(target);
          const result = await adapter.send({ ...extra, request: prepared.request, model: target.model, signal: signalFor(timeout, options.signal) });
          await record(prepared, attempt, target, { status: 'succeeded', usage: result.usage, finishReason: result.finishReason, latencyMs: deps.clock.now() - started }, logs);
          if (result.finishReason === 'content_filter' && !result.text && result.toolCalls.length === 0) {
            throw new GatewayError('refusal', 'The model declined the request.', { provider: target.provider });
          }
          return { prepared, result, target, attempts: attempt, logs };
        } catch (thrown) {
          const error = reclassify(target, thrown, options.signal);
          if (logs.length < attempt) {
            await record(
              prepared,
              attempt,
              target,
              {
                status: error.errorClass === 'cancelled' ? 'cancelled' : 'failed',
                usage: error.usage ? { ...ZERO_USAGE, ...error.usage } : ZERO_USAGE,
                errorClass: error.errorClass,
                latencyMs: deps.clock.now() - started,
              },
              logs,
            );
          }
          lastError = error;
          if (!shouldRetry(error, attempt)) throw error;
        }
      }
      throw lastError ?? new GatewayError('internal', 'No attempt was made.');
    } catch (error) {
      await settle(prepared, logs, null, prepared.request.countsAsRequest);
      logger.warn('ai.gateway.result', { callId: prepared.callId, status: 'failed', errorClass: (error as GatewayError).errorClass });
      throw error;
    }
  }

  function respond(prepared: Prepared, result: AdapterResult, target: Target, attempts: number, logs: AttemptLog[], toolCalls: ValidatedToolCall[] = []): GatewayResponse {
    const response: GatewayResponse = {
      callId: prepared.callId,
      text: result.text,
      toolCalls,
      finishReason: result.finishReason,
      usage: sumUsage(logs),
      provider: target.provider,
      model: result.model || target.model,
      latencyMs: deps.clock.now() - prepared.startedAt,
      attempts,
      routing: prepared.decision,
    };
    logger.info('ai.gateway.result', { callId: prepared.callId, status: 'succeeded', attempts, latencyMs: response.latencyMs, finishReason: response.finishReason });
    return response;
  }

  /* ------------------------------ generate -------------------------------- */

  async function generate(input: GatewayRequestInput, options: CallOptions = {}): Promise<GatewayResponse> {
    const { prepared, result, target, attempts, logs } = await execute('generate', input, options);
    await settle(prepared, logs, { text: result.text, target }, prepared.request.countsAsRequest);
    return respond(prepared, result, target, attempts, logs);
  }

  /* ----------------------------- structured ------------------------------- */

  /**
   * A response validated against `schema`. One bounded repair: the validation
   * errors are sent back once (metered as its own internal call). Otherwise a
   * `schema_validation` error — prose is never treated as data.
   */
  async function generateStructured<T>(
    input: GatewayRequestInput,
    schema: z.ZodType<T>,
    options: CallOptions & { name?: string } = {},
  ): Promise<{ data: T; response: GatewayResponse; repaired: boolean }> {
    const { toJSONSchema } = await import('zod');
    const jsonSchema = toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
    const name = options.name ?? 'result';

    const attemptOnce = async (request: GatewayRequestInput) => {
      const { prepared, result, target, attempts, logs } = await execute('structured', request, options, { responseSchema: { name, schema: jsonSchema } });
      await settle(prepared, logs, { text: result.text, target }, prepared.request.countsAsRequest);
      const response = respond(prepared, result, target, attempts, logs);
      let value: unknown;
      try {
        value = JSON.parse(stripFence(result.text));
      } catch {
        return { response, ok: false as const, issues: 'The reply was not valid JSON.' };
      }
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { response, ok: true as const, data: parsed.data }
        : { response, ok: false as const, issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
    };

    const first = await attemptOnce(input);
    if (first.ok) return { data: first.data, response: first.response, repaired: false };

    const repair = await attemptOnce({
      ...input,
      countsAsRequest: false,
      continuation: true,
      estimatedWords: 0,
      idempotencyKey: `${first.response.callId}:repair`,
      messages: [
        ...input.messages,
        { role: 'assistant', content: first.response.text || '(empty)' },
        { role: 'user', content: `That reply did not match the required schema (${first.issues.slice(0, 800)}). Reply again with only the corrected JSON.` },
      ],
    });
    if (repair.ok) return { data: repair.data, response: repair.response, repaired: true };
    throw new GatewayError('schema_validation', 'The model did not return data matching the schema.', { detail: repair.issues });
  }

  /* ------------------------------ tool calls ------------------------------ */

  async function toolCall(input: GatewayRequestInput, options: ToolCallOptions): Promise<ToolCallResponse> {
    const permitted = new Set(options.permittedTools);
    const offered = offeredTools(options.tools, permitted);
    if (offered.length === 0) throw new GatewayError('tool_validation', 'No permitted tool was offered.');
    const choice = typeof options.toolChoice === 'object' && !permitted.has(options.toolChoice.name) ? undefined : options.toolChoice;
    if (typeof options.toolChoice === 'object' && !choice) {
      throw new GatewayError('tool_validation', `Tool "${options.toolChoice.name}" is not permitted for this run.`);
    }

    const { prepared, result, target, attempts, logs } = await execute('tools', input, options, { tools: offered, toolChoice: choice });
    const { accepted, rejected } = validateToolCalls(result.toolCalls, offered, permitted);
    for (const call of rejected) {
      logger.warn('ai.gateway.tool', { callId: prepared.callId, name: call.name.slice(0, 64), status: 'rejected', reason: call.reason });
    }
    for (const call of accepted) logger.info('ai.gateway.tool', { callId: prepared.callId, name: call.name, status: 'validated' });

    const records = await deps.meter
      .toolCalls({
        callId: prepared.callId,
        provider: target.provider,
        model: target.model,
        userId: prepared.scope.userId,
        projectId: prepared.scope.projectId ?? null,
        runId: prepared.scope.runId ?? null,
        taskId: prepared.scope.taskId ?? null,
        accepted,
        rejected,
      })
      .catch((error: unknown) => {
        logger.error('ai.gateway.toolRecordFailed', { callId: prepared.callId, error: String(error).slice(0, 200) });
        return new Map<string, string>();
      });
    await settle(prepared, logs, { text: result.text, target }, prepared.request.countsAsRequest);
    return { ...respond(prepared, result, target, attempts, logs, accepted), rejectedToolCalls: rejected, toolCallRecords: Object.fromEntries(records) };
  }

  /* -------------------------------- stream -------------------------------- */

  /**
   * Streams text. Retries and failover only before the first event; after it,
   * a failure ends the stream (repeating text the reader already has would be
   * worse). Cancelling (the caller's signal, or abandoning the iterator) aborts
   * the provider request and records the attempt as cancelled with the usage
   * so far. Idle and total timeouts end a stalled stream.
   */
  async function* stream(input: GatewayRequestInput, options: CallOptions = {}): AsyncGenerator<StreamEvent, GatewayResponse> {
    const prepared = await prepare('stream', input, options);
    const logs: AttemptLog[] = [];
    const total = timeoutFor('stream', prepared.request.timeoutMs);
    const primary = prepared.decision.chosen;
    const fallback = prepared.decision.fallbacks[0];
    const promptTokens = estimateTokens(inputText(prepared.request));
    let lastError: GatewayError | undefined;
    let text = '';
    let final: { result: AdapterResult; target: Target; attempts: number } | null = null;
    let current: { attempt: number; target: Target; started: number; recorded: boolean; controller: AbortController } | null = null;

    try {
      for (let attempt = 1; ; attempt += 1) {
        const target = nextTarget(attempt, primary, fallback);
        if (!target) break;
        if (attempt > 1) {
          const notice = target === primary ? 'retry' : 'failover';
          deps.notify(notice);
          yield { type: 'notice', notice };
          const wait = backoffMs(attempt, lastError!, deps.clock, target === primary);
          if (wait > 0) {
            await deps.clock.sleep(wait, options.signal).catch(() => {
              throw new GatewayError('cancelled', 'The request was cancelled.');
            });
          }
        }
        const controller = new AbortController();
        current = { attempt, target, started: deps.clock.now(), recorded: false, controller };
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => controller.abort(new DOMException('The stream stalled.', 'TimeoutError')), STREAM_IDLE_MS);
        };
        try {
          const adapter = adapterFor(target);
          arm();
          for await (const event of adapter.stream({ request: prepared.request, model: target.model, signal: signalFor(total, options.signal, controller.signal) })) {
            arm();
            if (event.type === 'text') {
              text += event.text;
              yield { type: 'text_delta', text: event.text };
            } else {
              current.recorded = true;
              await record(prepared, attempt, target, { status: 'succeeded', usage: event.result.usage, finishReason: event.result.finishReason, latencyMs: deps.clock.now() - current.started }, logs);
              final = { result: event.result, target, attempts: attempt };
            }
          }
          if (!final) throw new GatewayError('network', 'The stream ended without a final event.', { provider: target.provider });
          break;
        } catch (thrown) {
          const error = reclassify(target, thrown, options.signal);
          if (!current.recorded) {
            current.recorded = true;
            await record(
              prepared,
              attempt,
              target,
              {
                status: error.errorClass === 'cancelled' ? 'cancelled' : 'failed',
                /* Text already delivered was generated and paid for: estimated rather than dropped. */
                usage: text ? { ...ZERO_USAGE, inputTokens: promptTokens, outputTokens: estimateTokens(text), estimated: true } : ZERO_USAGE,
                errorClass: error.errorClass,
                latencyMs: deps.clock.now() - current.started,
              },
              logs,
            );
          }
          lastError = error;
          if (text || !shouldRetry(error, attempt)) throw error;
        } finally {
          clearTimeout(idle);
          controller.abort();
        }
      }
      if (!final) throw lastError ?? new GatewayError('internal', 'No attempt was made.');
      const response = respond(prepared, final.result, final.target, final.attempts, logs);
      yield { type: 'done', response };
      return response;
    } finally {
      /* Also reached when the consumer abandons the iterator (a disconnected client). */
      if (current && !current.recorded) {
        current.recorded = true;
        current.controller.abort();
        await record(
          prepared,
          current.attempt,
          current.target,
          {
            status: 'cancelled',
            usage: text ? { ...ZERO_USAGE, inputTokens: promptTokens, outputTokens: estimateTokens(text), estimated: true } : ZERO_USAGE,
            errorClass: 'cancelled',
            latencyMs: deps.clock.now() - current.started,
          },
          logs,
        );
      }
      await settle(prepared, logs, final ? { text: final.result.text || text, target: final.target } : text ? { text, target: current?.target ?? primary } : null, prepared.request.countsAsRequest);
    }
  }

  /* -------------------------------- embed --------------------------------- */

  async function embed(input: EmbedRequestInput, options: CallOptions = {}): Promise<EmbedResponse> {
    const request = embedRequestSchema.parse(input);
    const scope = deps.scope();
    if (!scope?.userId) throw new GatewayError('internal', 'A model call was made outside a user scope.');
    if (scope.projectId) await deps.checkProject(scope.projectId, scope.userId);
    const adapters = deps.adapters();
    const candidates = (request.requested ? [request.requested.provider] : (['openai', 'google'] as Provider[])).filter(
      (provider) => adapters[provider]?.configured() && adapters[provider]?.embed,
    );
    const provider = candidates[0];
    if (!provider) throw new GatewayError('not_configured', 'No embedding provider is configured.');
    const adapter = adapters[provider]!;
    const model = request.requested?.model ?? adapter.embeddingModel!;
    const decision: RoutingDecision = {
      tier: (await deps.plan(scope.userId)).tier,
      requested: request.requested ?? null,
      chosen: { provider, model, modelClass: modelClass(provider, model) },
      fallbacks: [],
      reason: 'embedding',
    };
    const prepared: Prepared = {
      callId: randomUUID(),
      kind: 'embed',
      request: requestSchema.parse({ purpose: request.purpose, messages: [{ role: 'user', content: '(embedding)' }], countsAsRequest: false }),
      scope,
      decision,
      reservation: { id: '', userId: scope.userId, periodKey: '', requests: 0, words: 0, status: 'committed' },
      startedAt: deps.clock.now(),
    };
    const logs: AttemptLog[] = [];
    const timeout = timeoutFor('embed', request.timeoutMs);
    for (let attempt = 1; ; attempt += 1) {
      const started = deps.clock.now();
      try {
        const out = await adapter.embed!({ inputs: request.inputs, model, signal: signalFor(timeout, options.signal) });
        const usage = out.usage.estimated ? { ...out.usage, inputTokens: request.inputs.reduce((sum, text) => sum + estimateTokens(text), 0) } : out.usage;
        await record(prepared, attempt, decision.chosen, { status: 'succeeded', usage, latencyMs: deps.clock.now() - started }, logs);
        return { callId: prepared.callId, vectors: out.vectors, provider, model: out.model, usage };
      } catch (thrown) {
        const error = reclassify(decision.chosen, thrown, options.signal);
        await record(prepared, attempt, decision.chosen, { status: error.errorClass === 'cancelled' ? 'cancelled' : 'failed', usage: ZERO_USAGE, errorClass: error.errorClass, latencyMs: deps.clock.now() - started }, logs);
        if (!shouldRetry(error, attempt)) throw error;
        await deps.clock.sleep(backoffMs(attempt + 1, error, deps.clock), options.signal);
      }
    }
  }

  return { generate, stream, generateStructured, toolCall, embed };
}

export type ModelGateway = ReturnType<typeof createGateway>;
