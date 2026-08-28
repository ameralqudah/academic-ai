/**
 * Agent tasks — measurement, not enforcement.
 *
 * Every row here is one thing the user asked for, however many model calls it
 * took internally. That framing is the whole point: a request that runs eight
 * completions is one task to the person who made it, and billing it as eight is
 * both confusing and unfair.
 *
 * **Nothing in this file blocks anything.** Phase two records tasks and reports
 * them; it does not check them against a limit. The weights and quotas will be
 * set from these measurements once there are some, which is the opposite of the
 * usual order — guess a price, ship it, then discover it was wrong for real
 * usage. `subscription_plans.max_ai_tasks` is nullable for exactly this reason,
 * and null means "not enforced".
 *
 * The counters recorded are the ones needed to design that pricing later:
 * how many stages a task planned against how many it finished, how many model
 * calls it made, how long it took, how much data it touched, and what it cost.
 */

import { and, avg, count, desc, eq, gte, sql, sum } from 'drizzle-orm';

import { db } from '@/server/db';
import { agentTasks, type AgentTask, type NewAgentTask } from '@/server/db/schema';

/** `YYYY-MM`, the same aggregation key `usage_tracking` already uses. */
export function periodKeyFor(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function start(values: Omit<NewAgentTask, 'periodKey'>): Promise<AgentTask> {
  const [row] = await db
    .insert(agentTasks)
    .values({ ...values, periodKey: periodKeyFor() })
    .returning();
  if (!row) throw new Error('Failed to start agent task');
  return row;
}

/**
 * Records progress as a task runs.
 *
 * Called at each stage boundary rather than only at the end, so a task that
 * crashes still leaves evidence of how far it got. A task table whose rows only
 * appear on success measures the happy path and nothing else.
 */
export async function progress(
  id: string,
  values: Partial<
    Pick<
      NewAgentTask,
      | 'stagesCompleted'
      | 'aiRequestCount'
      | 'tokensIn'
      | 'tokensOut'
      | 'costMicroUsd'
      | 'generatedWords'
      | 'datasetRows'
      | 'detail'
    >
  >,
): Promise<void> {
  await db.update(agentTasks).set(values).where(eq(agentTasks.id, id));
}

export async function complete(
  id: string,
  values: {
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    chargedUnits?: number;
    stagesCompleted?: number;
    aiRequestCount?: number;
    tokensIn?: number;
    tokensOut?: number;
    costMicroUsd?: number;
    generatedWords?: number;
    durationMs?: number;
    detail?: Record<string, unknown>;
  },
): Promise<AgentTask | undefined> {
  const [row] = await db
    .update(agentTasks)
    .set({ ...values, completedAt: new Date() })
    .where(eq(agentTasks.id, id))
    .returning();
  return row;
}

export async function findOwned(id: string, userId: string): Promise<AgentTask | undefined> {
  const [row] = await db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.id, id), eq(agentTasks.userId, userId)))
    .limit(1);
  return row;
}

export async function listByUser(userId: string, limit = 50): Promise<AgentTask[]> {
  return db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.userId, userId))
    .orderBy(desc(agentTasks.startedAt))
    .limit(limit);
}

/**
 * What a user has used this month.
 *
 * Reported to them so the meter is visible while it is still not enforced —
 * a limit that appears the day it starts blocking is a limit nobody expected.
 */
export async function summaryForPeriod(
  userId: string,
  periodKey = periodKeyFor(),
): Promise<{ tasks: number; units: number; aiRequests: number; costMicroUsd: number }> {
  const [row] = await db
    .select({
      tasks: count(),
      units: sum(agentTasks.chargedUnits),
      aiRequests: sum(agentTasks.aiRequestCount),
      cost: sum(agentTasks.costMicroUsd),
    })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.userId, userId),
        eq(agentTasks.periodKey, periodKey),
        eq(agentTasks.status, 'COMPLETED'),
      ),
    );

  return {
    tasks: Number(row?.tasks ?? 0),
    units: Number(row?.units ?? 0),
    aiRequests: Number(row?.aiRequests ?? 0),
    costMicroUsd: Number(row?.cost ?? 0),
  };
}

/**
 * The numbers that will decide the pricing, broken down by kind of task.
 *
 * This is the query the whole shadow-mode exercise exists to make possible:
 * what does each sort of request actually cost, on real usage, rather than in
 * an estimate made before anyone had tried it.
 */
export async function costByKind(
  since: Date,
): Promise<
  {
    kind: string;
    runs: number;
    failed: number;
    avgAiRequests: number;
    avgDurationMs: number;
    avgCostMicroUsd: number;
    totalCostMicroUsd: number;
  }[]
> {
  const rows = await db
    .select({
      kind: agentTasks.kind,
      runs: count(),
      failed: sql<number>`count(*) filter (where ${agentTasks.status} = 'FAILED')::int`,
      avgAiRequests: avg(agentTasks.aiRequestCount),
      avgDurationMs: avg(agentTasks.durationMs),
      avgCost: avg(agentTasks.costMicroUsd),
      totalCost: sum(agentTasks.costMicroUsd),
    })
    .from(agentTasks)
    .where(gte(agentTasks.startedAt, since))
    .groupBy(agentTasks.kind)
    .orderBy(desc(count()));

  return rows.map((row) => ({
    kind: row.kind,
    runs: Number(row.runs ?? 0),
    failed: Number(row.failed ?? 0),
    avgAiRequests: Number(row.avgAiRequests ?? 0),
    avgDurationMs: Number(row.avgDurationMs ?? 0),
    avgCostMicroUsd: Number(row.avgCost ?? 0),
    totalCostMicroUsd: Number(row.totalCost ?? 0),
  }));
}

/**
 * How often the classifier picked the right intent, judged by whether the task
 * it chose then completed. A blunt measure, but the one that matters: an intent
 * that routinely leads to a failed task is a routing bug.
 */
export async function intentAccuracy(
  since: Date,
): Promise<{ intent: string; runs: number; completed: number }[]> {
  const rows = await db
    .select({
      intent: agentTasks.intent,
      runs: count(),
      completed: sql<number>`count(*) filter (where ${agentTasks.status} = 'COMPLETED')::int`,
    })
    .from(agentTasks)
    .where(gte(agentTasks.startedAt, since))
    .groupBy(agentTasks.intent);

  return rows
    .filter((row): row is typeof row & { intent: string } => row.intent !== null)
    .map((row) => ({
      intent: row.intent,
      runs: Number(row.runs ?? 0),
      completed: Number(row.completed ?? 0),
    }));
}
