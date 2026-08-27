import { asc, desc, eq } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  planFeatures,
  subscriptionPlans,
  subscriptions,
  type PlanFeature,
  type Subscription,
  type SubscriptionPlan,
} from '@/server/db/schema';

export interface PlanWithFeatures extends SubscriptionPlan {
  features: PlanFeature[];
}

export async function listActivePlans(): Promise<PlanWithFeatures[]> {
  const plans = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isActive, true))
    .orderBy(asc(subscriptionPlans.sortOrder));

  if (plans.length === 0) return [];

  const features = await db.select().from(planFeatures).orderBy(asc(planFeatures.sortOrder));

  return plans.map((plan) => ({
    ...plan,
    features: features.filter((feature) => feature.planId === plan.id),
  }));
}

export async function findPlanByCode(code: string): Promise<SubscriptionPlan | undefined> {
  const [row] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.code, code))
    .limit(1);
  return row;
}

/** The highest-priced active plan — what "everything unlocked" means here. */
export async function findTopPlan(): Promise<SubscriptionPlan | undefined> {
  const [row] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isActive, true))
    .orderBy(desc(subscriptionPlans.priceCents))
    .limit(1);
  return row;
}

export async function findDefaultPlan(): Promise<SubscriptionPlan | undefined> {
  const [row] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.isDefault, true))
    .limit(1);
  return row;
}

export interface SubscriptionWithPlan {
  subscription: Subscription;
  plan: SubscriptionPlan;
}

export async function findSubscriptionByUser(
  userId: string,
): Promise<SubscriptionWithPlan | undefined> {
  const [row] = await db
    .select({ subscription: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return row;
}

/** Used by webhooks that carry only the gateway's subscription id. */
export async function findSubscriptionByExternalId(
  externalSubscriptionId: string,
): Promise<SubscriptionWithPlan | undefined> {
  const [row] = await db
    .select({ subscription: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .where(eq(subscriptions.externalSubscriptionId, externalSubscriptionId))
    .limit(1);
  return row;
}

export async function createSubscription(values: typeof subscriptions.$inferInsert) {
  const [row] = await db.insert(subscriptions).values(values).returning();
  if (!row) throw new Error('Failed to create subscription');
  return row;
}

/**
 * Idempotent lazy-create.
 *
 * `subscriptions.userId` is unique, and several server components resolve a
 * user's plan concurrently on the same request (layout, page, usage summary).
 * A plain insert would make the losing race throw a raw Postgres 23505 and blow
 * up the render, so the conflict is absorbed and the existing row returned.
 */
export async function ensureSubscription(
  values: typeof subscriptions.$inferInsert,
): Promise<Subscription> {
  const [inserted] = await db
    .insert(subscriptions)
    .values(values)
    .onConflictDoNothing({ target: subscriptions.userId })
    .returning();

  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, values.userId))
    .limit(1);

  if (!existing) throw new Error('Failed to create subscription');
  return existing;
}

export async function updateSubscription(
  id: string,
  values: Partial<typeof subscriptions.$inferInsert>,
) {
  await db.update(subscriptions).set(values).where(eq(subscriptions.id, id));
}
