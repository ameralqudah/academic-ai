import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import { usageTracking } from '@/server/db/schema';

export type UsageMetric = 'AI_REQUEST' | 'GENERATED_WORD' | 'PROJECT' | 'TOOL_RUN' | 'EXPORT';

export function periodKeyFor(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function nextPeriodStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export async function record(values: typeof usageTracking.$inferInsert): Promise<void> {
  await db.insert(usageTracking).values(values);
}

/** One grouped query — never scan the raw rows to answer "what is left". */
export async function totalsForPeriod(
  userId: string,
  periodKey: string,
): Promise<Record<UsageMetric, number>> {
  const rows = await db
    .select({
      metric: usageTracking.metric,
      total: sql<number>`coalesce(sum(${usageTracking.amount}), 0)::int`,
    })
    .from(usageTracking)
    .where(and(eq(usageTracking.userId, userId), eq(usageTracking.periodKey, periodKey)))
    .groupBy(usageTracking.metric);

  const totals: Record<UsageMetric, number> = {
    AI_REQUEST: 0,
    GENERATED_WORD: 0,
    PROJECT: 0,
    TOOL_RUN: 0,
    EXPORT: 0,
  };

  for (const row of rows) totals[row.metric as UsageMetric] = Number(row.total);
  return totals;
}

export async function costForPeriod(userId: string, periodKey: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageTracking.costMicroUsd}), 0)::bigint` })
    .from(usageTracking)
    .where(and(eq(usageTracking.userId, userId), eq(usageTracking.periodKey, periodKey)));
  return Number(row?.total ?? 0);
}
