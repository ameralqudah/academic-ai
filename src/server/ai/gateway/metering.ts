/**
 * Durable per-attempt usage records (P1-B §2.5) and tool-call records (§2.7).
 * Written for every attempt — success, failure or cancellation — so a failed
 * call still leaves its trace and its cost.
 */

import { eq } from 'drizzle-orm';

import { costFor } from '@/ai/prices';
import { aiToolCalls, aiUsageEvents } from '@/server/db/schema';

/* Loaded on first write, so the pure parts of this module (costing) import without a database. */
const database = async () => (await import('@/server/db')).db;

import type { ModelClass, Provider, RequestKind, RoutingDecision, Usage } from './contract';
import type { RejectedToolCall } from './tools';

export interface AttemptRecord {
  callId: string;
  attempt: number;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  jobId: string | null;
  runId: string | null;
  stepId?: string | null;
  purpose: string;
  kind: RequestKind;
  provider: Provider;
  model: string;
  modelClass: ModelClass;
  status: 'succeeded' | 'failed' | 'cancelled';
  errorClass: string | null;
  finishReason: string | null;
  usage: Usage;
  costMicroUsd: number;
  latencyMs: number;
  routing: RoutingDecision;
  reservationId: string | null;
}

/** Cost of an attempt at the model that served it. Unknown models are priced at a conservative fallback. */
export function attemptCost(model: string, usage: Usage): number {
  const legacy = {
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
  /* Unknown model: a deliberately high estimate (premium rates) rather than zero. */
  return costFor(model, legacy, () => Math.round(((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) * 5 + usage.outputTokens * 25)));
}

export interface Meter {
  attempt(record: AttemptRecord): Promise<void>;
  toolCalls(input: {
    callId: string;
    provider: Provider;
    model: string;
    userId: string;
    projectId: string | null;
    runId: string | null;
    stepId?: string | null;
    taskId: string | null;
    accepted: { id: string; name: string; arguments: Record<string, unknown> }[];
    rejected: RejectedToolCall[];
  }): Promise<Map<string, string>>;
}

export const databaseMeter: Meter = {
  async attempt(record) {
    const db = await database();
    await db.insert(aiUsageEvents).values({
      callId: record.callId,
      attempt: record.attempt,
      userId: record.userId,
      projectId: record.projectId,
      taskId: record.taskId,
      jobId: record.jobId,
      runId: record.runId,
      stepId: record.stepId ?? null,
      purpose: record.purpose,
      kind: record.kind,
      provider: record.provider,
      model: record.model.slice(0, 100),
      modelClass: record.modelClass,
      status: record.status,
      errorClass: record.errorClass,
      finishReason: record.finishReason,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      cacheReadTokens: record.usage.cacheReadTokens,
      cacheWriteTokens: record.usage.cacheWriteTokens,
      totalTokens: record.usage.inputTokens + record.usage.outputTokens + record.usage.cacheReadTokens + record.usage.cacheWriteTokens,
      usageEstimated: record.usage.estimated,
      costMicroUsd: record.costMicroUsd,
      currency: 'USD',
      latencyMs: record.latencyMs,
      retryCount: record.attempt - 1,
      routing: record.routing as unknown as Record<string, unknown>,
      reservationId: record.reservationId,
    });
  },

  async toolCalls(input) {
    const rows = [
      ...input.accepted.map((call) => ({ toolCallId: call.id, toolName: call.name, arguments: call.arguments, rawArguments: null, status: 'validated', error: null })),
      ...input.rejected.map((call) => ({ toolCallId: call.id, toolName: call.name.slice(0, 64), arguments: null, rawArguments: call.raw, status: 'rejected', error: `${call.reason}: ${call.detail}` })),
    ];
    const ids = new Map<string, string>();
    if (rows.length === 0) return ids;
    const db = await database();
    const inserted = await db
      .insert(aiToolCalls)
      .values(
        rows.map((row) => ({
          ...row,
          callId: input.callId,
          provider: input.provider,
          model: input.model.slice(0, 100),
          userId: input.userId,
          projectId: input.projectId,
          runId: input.runId,
          stepId: input.stepId ?? null,
          taskId: input.taskId,
        })),
      )
      .returning({ id: aiToolCalls.id, toolCallId: aiToolCalls.toolCallId });
    for (const row of inserted) ids.set(row.toolCallId, row.id);
    return ids;
  },
};

/**
 * Records the outcome of executing a validated tool call. Called by the run
 * engine (P1-D) — the gateway validates and records calls; it never executes
 * them itself.
 */
export async function recordToolExecution(
  recordId: string,
  outcome: { status: 'succeeded' | 'failed'; latencyMs: number; resultSummary?: Record<string, unknown>; error?: string },
): Promise<void> {
  const db = await database();
  await db
    .update(aiToolCalls)
    .set({
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      resultSummary: outcome.resultSummary ?? null,
      error: outcome.error?.slice(0, 2000) ?? null,
      finishedAt: new Date(),
    })
    .where(eq(aiToolCalls.id, recordId));
}
