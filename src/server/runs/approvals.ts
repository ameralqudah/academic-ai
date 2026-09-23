/**
 * Hashes that bind an execution to exactly what was planned and approved (P1-D).
 *
 * - `inputHash`: the validated input of a step.
 * - `stepIdempotencyKey`: project + run + seq + tool + version + input hash. A
 *   step's effects are keyed by it, so a retry never repeats them.
 * - `actionHash`: what a person approves — the step, the tool and version, the
 *   validated input, the current state of what it touches (content hashes,
 *   versions) and, for graph changes, the Impact Report hash. Recomputed just
 *   before execution: if anything moved, the approval no longer matches and a
 *   new one is asked for. An approval is never a boolean.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '@/analysis/engine/types';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function inputHash(validatedInput: Record<string, unknown>): string {
  return sha256(canonicalJson(validatedInput));
}

export function stepIdempotencyKey(parts: { projectId: string; runId: string; seq: number; tool: string; toolVersion: string; inputHash: string }): string {
  return sha256(canonicalJson({ kind: 'run-step', ...parts }));
}

/** For a tool call made by the analysis assistant: keyed by its durable `ai_tool_calls` row. */
export function assistantIdempotencyKey(toolCallRecordId: string): string {
  return sha256(canonicalJson({ kind: 'assistant-call', toolCallRecordId }));
}

export function actionHash(parts: {
  projectId: string;
  runId: string;
  stepId: string;
  userId: string;
  tool: string;
  toolVersion: string;
  inputHash: string;
  reason: string;
  targets: Record<string, string>;
  impactHash?: string | null;
}): string {
  return sha256(canonicalJson({ kind: 'approval', ...parts, impactHash: parts.impactHash ?? null }));
}
