/**
 * Every limit on a research run, in one place (P1-D).
 *
 * Values are per plan tier (the tier the Model Gateway derives), from
 * docs/phase1/P1D_PLAN.md. They can be overridden by `RUN_LIMITS` (JSON keyed
 * by tier), but never above the hard ceilings below: a misconfiguration can
 * make a run stricter, not unbounded. Nothing else in the code carries a
 * number for these; the executor, the policy, the planner, the store and the
 * assistant all read them from here.
 */

import { z } from 'zod';

import { getEnv } from '@/config/env';
import type { Tier } from '@/server/ai/gateway/routing';

export type { Tier };

export interface RunLimits {
  /** Steps a plan may contain (and a run may execute). */
  maxSteps: number;
  /** Tool calls one step makes (a step is one tool call). */
  maxToolCallsPerStep: number;
  /** Tool calls the model may request in one assistant round. */
  maxToolCallsPerRound: number;
  /** Assistant rounds (model ↔ tools) per request. */
  maxAssistantRounds: number;
  /** Times a run may extend its plan. */
  maxReplans: number;
  /** Nested runs: a tool can never start a run. */
  maxDepth: number;
  /** Attempts per step (retries + 1); destructive tools always get 1. */
  maxAttemptsPerStep: number;
  /** Retries across the whole run. */
  maxRetriesPerRun: number;
  /** Wall time of a run, from its start. */
  maxDurationMs: number;
  /** Longest a single step may run (a tool's own timeout is capped by this). */
  maxStepMs: number;
  /** Model tokens per run, metered from `ai_usage_events`. */
  maxRunTokens: number;
  /** Model cost per run, metered, in micro-USD. */
  maxCostMicroUsd: number;
  /** Model cost per user per day across runs, metered, in micro-USD. */
  maxDailyCostMicroUsd: number;
  /** Runs a user may have unfinished at once. */
  maxActiveRuns: number;
  /** Bytes of one step's input (planned or validated). */
  maxStepInputBytes: number;
  /** Bytes of one step's stored output. */
  maxStepOutputBytes: number;
  /** Bytes of a stored plan. */
  maxPlanBytes: number;
  /** Characters of an intent. */
  maxIntentChars: number;
  /** How long an approval request stays open. */
  approvalTtlMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_RUN_LIMITS: Readonly<Record<Tier, Readonly<RunLimits>>> = Object.freeze({
  free: Object.freeze({
    maxSteps: 10,
    maxToolCallsPerStep: 1,
    maxToolCallsPerRound: 3,
    maxAssistantRounds: 4,
    maxReplans: 1,
    maxDepth: 0,
    maxAttemptsPerStep: 3,
    maxRetriesPerRun: 4,
    maxDurationMs: 10 * MINUTE,
    maxStepMs: 5 * MINUTE,
    maxRunTokens: 60_000,
    maxCostMicroUsd: 200_000,
    maxDailyCostMicroUsd: 1_000_000,
    maxActiveRuns: 1,
    maxStepInputBytes: 16_384,
    maxStepOutputBytes: 65_536,
    maxPlanBytes: 65_536,
    maxIntentChars: 4_000,
    approvalTtlMs: 24 * 60 * MINUTE,
  }),
  paid: Object.freeze({
    maxSteps: 20,
    maxToolCallsPerStep: 1,
    maxToolCallsPerRound: 5,
    maxAssistantRounds: 4,
    maxReplans: 1,
    maxDepth: 0,
    maxAttemptsPerStep: 3,
    maxRetriesPerRun: 8,
    maxDurationMs: 30 * MINUTE,
    maxStepMs: 10 * MINUTE,
    maxRunTokens: 400_000,
    maxCostMicroUsd: 2_000_000,
    maxDailyCostMicroUsd: 20_000_000,
    maxActiveRuns: 3,
    maxStepInputBytes: 16_384,
    maxStepOutputBytes: 65_536,
    maxPlanBytes: 65_536,
    maxIntentChars: 4_000,
    approvalTtlMs: 24 * 60 * MINUTE,
  }),
  admin: Object.freeze({
    maxSteps: 30,
    maxToolCallsPerStep: 1,
    maxToolCallsPerRound: 8,
    maxAssistantRounds: 6,
    maxReplans: 2,
    maxDepth: 0,
    maxAttemptsPerStep: 4,
    maxRetriesPerRun: 12,
    maxDurationMs: 60 * MINUTE,
    maxStepMs: 15 * MINUTE,
    maxRunTokens: 1_000_000,
    maxCostMicroUsd: 10_000_000,
    maxDailyCostMicroUsd: 100_000_000,
    maxActiveRuns: 5,
    maxStepInputBytes: 16_384,
    maxStepOutputBytes: 65_536,
    maxPlanBytes: 65_536,
    maxIntentChars: 4_000,
    approvalTtlMs: 24 * 60 * MINUTE,
  }),
});

/**
 * Hard ceilings. The database CHECKs enforce the byte limits independently
 * (migration 0014), and `maxDepth` is structurally 0 (no tool starts a run).
 */
export const HARD_CEILINGS: Readonly<RunLimits> = Object.freeze({
  maxSteps: 30,
  maxToolCallsPerStep: 1,
  maxToolCallsPerRound: 8,
  maxAssistantRounds: 6,
  maxReplans: 2,
  maxDepth: 0,
  maxAttemptsPerStep: 5,
  maxRetriesPerRun: 20,
  maxDurationMs: 120 * MINUTE,
  maxStepMs: 30 * MINUTE,
  maxRunTokens: 2_000_000,
  maxCostMicroUsd: 50_000_000,
  maxDailyCostMicroUsd: 200_000_000,
  maxActiveRuns: 10,
  maxStepInputBytes: 16_384,
  maxStepOutputBytes: 65_536,
  maxPlanBytes: 65_536,
  maxIntentChars: 4_000,
  approvalTtlMs: 7 * 24 * 60 * MINUTE,
});

const keys = Object.keys(HARD_CEILINGS) as (keyof RunLimits)[];
const overrideSchema = z
  .object({
    free: z.object(Object.fromEntries(keys.map((key) => [key, z.number().int().min(0).optional()]))).strict().optional(),
    paid: z.object(Object.fromEntries(keys.map((key) => [key, z.number().int().min(0).optional()]))).strict().optional(),
    admin: z.object(Object.fromEntries(keys.map((key) => [key, z.number().int().min(0).optional()]))).strict().optional(),
  })
  .strict();

let resolved: Record<Tier, Readonly<RunLimits>> | null = null;

/** Parses `RUN_LIMITS`; throws on unknown keys or values above a ceiling. */
export function resolveLimits(raw: string | undefined): Record<Tier, Readonly<RunLimits>> {
  const overrides = raw ? overrideSchema.parse(JSON.parse(raw)) : {};
  const out = {} as Record<Tier, Readonly<RunLimits>>;
  for (const tier of ['free', 'paid', 'admin'] as const) {
    const merged = { ...DEFAULT_RUN_LIMITS[tier], ...(overrides[tier] ?? {}) } as RunLimits;
    for (const key of keys) {
      if (merged[key] > HARD_CEILINGS[key]) throw new Error(`RUN_LIMITS.${tier}.${key} = ${merged[key]} exceeds the ceiling ${HARD_CEILINGS[key]}`);
    }
    if (merged.maxDepth !== 0) throw new Error('RUN_LIMITS: maxDepth is 0 (a tool never starts a run)');
    if (merged.maxToolCallsPerStep !== 1) throw new Error('RUN_LIMITS: a step is exactly one tool call');
    out[tier] = Object.freeze(merged);
  }
  return out;
}

export function limitsFor(tier: Tier): Readonly<RunLimits> {
  resolved ??= resolveLimits(getEnv().RUN_LIMITS);
  return resolved[tier];
}

/** For tests after changing the environment. */
export function resetLimits(): void {
  resolved = null;
}

/** Bytes of a value as stored (canonical JSON length is what the CHECKs measure: text form). */
export function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

/**
 * Pre-execution estimates of one model call, for the cost check before a step
 * runs (the check after uses metered usage). Deliberately high, so an estimate
 * stops a run early rather than late.
 */
export const MODEL_CALL_ESTIMATE = Object.freeze({ tokens: 6_000, costMicroUsd: 60_000 });
