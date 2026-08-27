import { and, count, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '@/server/db';
import {
  payments,
  subscriptionPlans,
  subscriptions,
  users,
  type NewPayment,
  type Payment,
} from '@/server/db/schema';

export async function listByUser(userId: string, limit = 24): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.occurredAt))
    .limit(limit);
}

export async function findByExternalPaymentId(
  externalPaymentId: string,
): Promise<Payment | undefined> {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.externalPaymentId, externalPaymentId))
    .limit(1);
  return row;
}

export interface PaymentWithUser extends Payment {
  userName: string | null;
  userEmail: string;
}

export async function listRecent(limit = 100): Promise<PaymentWithUser[]> {
  const rows = await db
    .select({ payment: payments, name: users.name, email: users.email })
    .from(payments)
    .innerJoin(users, eq(payments.userId, users.id))
    .orderBy(desc(payments.occurredAt))
    .limit(limit);

  return rows.map((row) => ({ ...row.payment, userName: row.name, userEmail: row.email }));
}

/**
 * Insert-or-ignore on the gateway's payment id.
 *
 * Webhook redelivery is normal operation, not an error: PayPal retries until it
 * gets a 200, and a network blip after we commit means the same sale arrives
 * twice. Counting it twice would overstate revenue in the admin dashboard.
 */
export async function record(values: NewPayment): Promise<Payment | undefined> {
  if (!values.externalPaymentId) {
    const [row] = await db.insert(payments).values(values).returning();
    return row;
  }

  const [row] = await db
    .insert(payments)
    .values(values)
    .onConflictDoNothing({ target: payments.externalPaymentId })
    .returning();

  return row;
}

export interface RevenueSummary {
  paymentsCount: number;
  succeededCount: number;
  failedCount: number;
  grossCents: number;
  refundedCents: number;
  last30DaysCents: number;
  currency: string;
}

export async function revenueSummary(): Promise<RevenueSummary> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      paymentsCount: count(),
      succeeded: sql<number>`count(*) filter (where ${payments.status} = 'SUCCEEDED')`.mapWith(
        Number,
      ),
      failed: sql<number>`count(*) filter (where ${payments.status} = 'FAILED')`.mapWith(Number),
      gross: sql<number>`coalesce(sum(${payments.amountCents}) filter (where ${payments.status} = 'SUCCEEDED'), 0)`.mapWith(
        Number,
      ),
      refunded: sql<number>`coalesce(sum(${payments.amountCents}) filter (where ${payments.status} = 'REFUNDED'), 0)`.mapWith(
        Number,
      ),
    })
    .from(payments);

  const [recent] = await db
    .select({
      total: sql<number>`coalesce(sum(${payments.amountCents}), 0)`.mapWith(Number),
    })
    .from(payments)
    .where(and(eq(payments.status, 'SUCCEEDED'), gte(payments.occurredAt, thirtyDaysAgo)));

  const [currencyRow] = await db
    .select({ currency: payments.currency })
    .from(payments)
    .orderBy(desc(payments.occurredAt))
    .limit(1);

  return {
    paymentsCount: totals?.paymentsCount ?? 0,
    succeededCount: totals?.succeeded ?? 0,
    failedCount: totals?.failed ?? 0,
    grossCents: totals?.gross ?? 0,
    refundedCents: totals?.refunded ?? 0,
    last30DaysCents: recent?.total ?? 0,
    currency: currencyRow?.currency ?? 'USD',
  };
}

/** Monthly recurring revenue from the plans people are actually subscribed to. */
export async function activeRecurringCents(): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${subscriptionPlans.priceCents}), 0)`.mapWith(Number),
    })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .where(eq(subscriptions.status, 'ACTIVE'));

  return row?.total ?? 0;
}
