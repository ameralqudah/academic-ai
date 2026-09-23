/**
 * The shape of a tool in the research-run registry (P1-D).
 *
 * A tool is an adapter over an existing service function: it declares what it
 * touches and how risky it is, and the policy decides from that declaration —
 * never from the model. Adapters contain no business logic and no statistics
 * (P1-C stays the only statistics authority).
 */

import type { z } from 'zod';

import type { Tier } from './limits';

export type ToolCategory = 'data' | 'statistics' | 'research' | 'writing' | 'graph';

/**
 * - read: reads project data;
 * - compute: computes and stores a new, immutable result (statistics runs, specifications);
 * - write: adds to the project (a dataset version, a graph node, a claim);
 * - external_read: reads from outside (scholarly search, a web page);
 * - destructive: makes existing results stale or replaces them.
 */
export type SideEffect = 'read' | 'compute' | 'write' | 'external_read' | 'destructive';
export type Risk = 'low' | 'medium' | 'high';
export type ProjectRole = 'VIEWER' | 'EDITOR' | 'OWNER';
/** Where a tool may be offered: a research run, and/or the analysis assistant. */
export type ToolContextKind = 'run' | 'assistant';

/** A project resource named in a tool's input, checked by the policy before execution. */
export interface ResourceRef {
  kind: 'datasetVersion' | 'spec' | 'statRun' | 'graphNode';
  id: string;
}

/** Why an action needs a person's approval, and exactly what it will do. */
export interface ApprovalNeed {
  reason: string;
  /** One sentence for the approval card (English and Arabic). */
  summary: { en: string; ar: string };
  /** The current versions/hashes of what the action touches; part of the approval hash. */
  targets: Record<string, string>;
  /** For graph-affecting actions: the Impact Report hash the approval covers. */
  impactHash?: string | null;
  /** A bounded structured preview for the card. */
  preview?: Record<string, unknown>;
}

export interface ToolContext {
  userId: string;
  projectId: string;
  tier: Tier;
  execution: ToolContextKind;
  /** Research run and step, when executing in a run (provenance and metering). */
  runId?: string;
  stepId?: string;
  /** Mutating tools use this so a retried step never repeats its effect. */
  idempotencyKey: string;
  signal: AbortSignal;
  /** The Impact Report hash the approval covered, for graph writes that re-check it. */
  approvedImpactHash?: string | null;
}

export interface ToolResult<O> {
  output: O;
  /** What the step produced, by reference (a stat run, a version, a node…). */
  ref?: { kind: string; id: string } | null;
}

export interface ToolDef<I extends Record<string, unknown> = Record<string, unknown>, O extends Record<string, unknown> = Record<string, unknown>> {
  /** Provider-safe, unique: /^[a-zA-Z][a-zA-Z0-9]{2,63}$/. */
  name: string;
  version: string;
  description: string;
  category: ToolCategory;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  sideEffect: SideEffect;
  risk: Risk;
  requiredRole: ProjectRole;
  /** Plan tiers that may use it. */
  tiers: readonly Tier[];
  contexts: readonly ToolContextKind[];
  timeoutMs: number;
  /** Attempts (1 = no retry). Destructive tools are always 1. */
  maxAttempts: number;
  /**
   * - natural: repeating it has no effect (reads, pure computations);
   * - keyed: it creates something, and is idempotent on `ctx.idempotencyKey`.
   * Every tool whose side effect is not `read`/`external_read` must be keyed.
   */
  idempotency: 'natural' | 'keyed';
  /** The project resources its input names (all checked by the policy). */
  resources(input: I): ResourceRef[];
  /** Null when it may run without asking; otherwise what the person must approve. */
  approval(input: I, ctx: ToolContext): Promise<ApprovalNeed | null>;
  /** Model calls it makes itself (for the pre-execution cost check). */
  estimatedModelCalls: number;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/** Defines a tool with its types inferred from the schemas. */
export function defineRunTool<I extends Record<string, unknown>, O extends Record<string, unknown>>(tool: ToolDef<I, O>): ToolDef {
  return tool as unknown as ToolDef;
}
