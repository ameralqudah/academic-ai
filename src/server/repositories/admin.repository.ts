import { and, count, desc, eq, gt, gte, ilike, or, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  researchProjects,
  subscriptionPlans,
  subscriptions,
  usageTracking,
  users,
} from '@/server/db/schema';

export interface PlatformStats {
  totalUsers: number;
  newUsers30d: number;
  suspendedUsers: number;
  proUsers: number;
  activeSubscriptions: number;
  monthlyRevenueCents: number;
  totalProjects: number;
  aiRequestsThisPeriod: number;
  wordsThisPeriod: number;
  estimatedCostMicroUsd: number;
}

export async function platformStats(periodKey: string): Promise<PlatformStats> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);

  const [
    userTotals,
    newUsers,
    suspended,
    paidSubs,
    projectTotals,
    usageTotals,
  ] = await Promise.all([
    db.select({ value: count() }).from(users),
    db.select({ value: count() }).from(users).where(gte(users.createdAt, since)),
    db.select({ value: count() }).from(users).where(eq(users.status, 'SUSPENDED')),
    db
      .select({
        subscriptions: count(),
        revenue: sql<number>`coalesce(sum(${subscriptionPlans.priceCents}), 0)::int`,
      })
      .from(subscriptions)
      .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
      .where(and(eq(subscriptions.status, 'ACTIVE'), sql`${subscriptionPlans.priceCents} > 0`)),
    db.select({ value: count() }).from(researchProjects),
    db
      .select({
        requests: sql<number>`coalesce(sum(case when ${usageTracking.metric} = 'AI_REQUEST' then ${usageTracking.amount} else 0 end), 0)::int`,
        words: sql<number>`coalesce(sum(case when ${usageTracking.metric} = 'GENERATED_WORD' then ${usageTracking.amount} else 0 end), 0)::int`,
        cost: sql<number>`coalesce(sum(${usageTracking.costMicroUsd}), 0)::bigint`,
      })
      .from(usageTracking)
      .where(eq(usageTracking.periodKey, periodKey)),
  ]);

  return {
    totalUsers: userTotals[0]?.value ?? 0,
    newUsers30d: newUsers[0]?.value ?? 0,
    suspendedUsers: suspended[0]?.value ?? 0,
    proUsers: paidSubs[0]?.subscriptions ?? 0,
    activeSubscriptions: paidSubs[0]?.subscriptions ?? 0,
    monthlyRevenueCents: Number(paidSubs[0]?.revenue ?? 0),
    totalProjects: projectTotals[0]?.value ?? 0,
    aiRequestsThisPeriod: Number(usageTotals[0]?.requests ?? 0),
    wordsThisPeriod: Number(usageTotals[0]?.words ?? 0),
    estimatedCostMicroUsd: Number(usageTotals[0]?.cost ?? 0),
  };
}

export interface AdminUserRow {
  id: string;
  name: string | null;
  email: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date;
  lastLoginAt: Date | null;
  planCode: string | null;
  subscriptionStatus: string | null;
  projects: number;
}

export async function listUsers(input: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: AdminUserRow[]; total: number }> {
  const where = input.search
    ? or(ilike(users.email, `%${input.search}%`), ilike(users.name, `%${input.search}%`))
    : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        planCode: subscriptionPlans.code,
        subscriptionStatus: subscriptions.status,
        projects: sql<number>`(
          select count(*)::int from ${researchProjects}
          where ${researchProjects.userId} = ${users.id}
        )`,
      })
      .from(users)
      .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
      .leftJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ value: count() }).from(users).where(where),
  ]);

  return { rows: rows as AdminUserRow[], total: totals[0]?.value ?? 0 };
}

export interface SubscriberRow {
  userId: string;
  name: string | null;
  email: string;
  planCode: string;
  planNameEn: string;
  planNameAr: string;
  priceCents: number;
  currency: string;
  status: string;
  provider: string;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  externalSubscriptionId: string | null;
  startedAt: Date;
}

/** Everyone on a paid plan, newest first — the list an operator actually wants. */
export async function listSubscribers(limit = 100): Promise<SubscriberRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      planCode: subscriptionPlans.code,
      planNameEn: subscriptionPlans.nameEn,
      planNameAr: subscriptionPlans.nameAr,
      priceCents: subscriptionPlans.priceCents,
      currency: subscriptionPlans.currency,
      status: subscriptions.status,
      provider: subscriptions.provider,
      periodEnd: subscriptions.periodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      externalSubscriptionId: subscriptions.externalSubscriptionId,
      startedAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .innerJoin(users, eq(subscriptions.userId, users.id))
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .where(gt(subscriptionPlans.priceCents, 0))
    .orderBy(desc(subscriptions.createdAt))
    .limit(limit);

  return rows as SubscriberRow[];
}

export interface UsageByUserRow {
  userId: string;
  email: string;
  name: string | null;
  requests: number;
  words: number;
  costMicroUsd: number;
}

export async function usageByUser(periodKey: string, limit = 25): Promise<UsageByUserRow[]> {
  const rows = await db
    .select({
      userId: usageTracking.userId,
      email: users.email,
      name: users.name,
      requests: sql<number>`coalesce(sum(case when ${usageTracking.metric} = 'AI_REQUEST' then ${usageTracking.amount} else 0 end), 0)::int`,
      words: sql<number>`coalesce(sum(case when ${usageTracking.metric} = 'GENERATED_WORD' then ${usageTracking.amount} else 0 end), 0)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${usageTracking.costMicroUsd}), 0)::bigint`,
    })
    .from(usageTracking)
    .innerJoin(users, eq(users.id, usageTracking.userId))
    .where(eq(usageTracking.periodKey, periodKey))
    .groupBy(usageTracking.userId, users.email, users.name)
    .orderBy(desc(sql`sum(${usageTracking.costMicroUsd})`))
    .limit(limit);

  return rows.map((row) => ({ ...row, costMicroUsd: Number(row.costMicroUsd) }));
}

export interface ProviderUsageRow {
  provider: string | null;
  model: string | null;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
}

export async function usageByProvider(periodKey: string): Promise<ProviderUsageRow[]> {
  const rows = await db
    .select({
      provider: usageTracking.provider,
      model: usageTracking.model,
      requests: count(),
      tokensIn: sql<number>`coalesce(sum(${usageTracking.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${usageTracking.tokensOut}), 0)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${usageTracking.costMicroUsd}), 0)::bigint`,
    })
    .from(usageTracking)
    .where(and(eq(usageTracking.periodKey, periodKey), eq(usageTracking.metric, 'AI_REQUEST')))
    .groupBy(usageTracking.provider, usageTracking.model)
    .orderBy(desc(sql`sum(${usageTracking.costMicroUsd})`));

  return rows.map((row) => ({ ...row, costMicroUsd: Number(row.costMicroUsd) }));
}

/** Daily AI request counts for the last N days — the admin dashboard sparkline. */
export async function dailyUsage(days = 30): Promise<{ day: string; requests: number }[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageTracking.createdAt}), 'YYYY-MM-DD')`,
      requests: sql<number>`coalesce(sum(${usageTracking.amount}), 0)::int`,
    })
    .from(usageTracking)
    .where(and(gte(usageTracking.createdAt, since), eq(usageTracking.metric, 'AI_REQUEST')))
    .groupBy(sql`date_trunc('day', ${usageTracking.createdAt})`)
    .orderBy(sql`date_trunc('day', ${usageTracking.createdAt})`);

  return rows;
}

export async function setUserStatus(
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<void> {
  await db.update(users).set({ status }).where(eq(users.id, userId));
}

export async function setUserRole(userId: string, role: 'USER' | 'ADMIN'): Promise<void> {
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function updatePlan(
  planId: string,
  values: Partial<typeof subscriptionPlans.$inferInsert>,
): Promise<void> {
  await db.update(subscriptionPlans).set(values).where(eq(subscriptionPlans.id, planId));
}
