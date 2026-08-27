import { billingProvider, type BillingEvent } from '@/server/billing';
import { PayPalBillingProvider } from '@/server/billing/paypal';
import { isOwnerEmail } from '@/server/auth/owner';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import * as paymentsRepo from '@/server/repositories/payments.repository';
import * as plansRepo from '@/server/repositories/plans.repository';
import * as usersRepo from '@/server/repositories/users.repository';

export async function startCheckout(input: {
  userId: string;
  planCode: string;
  locale: string;
}): Promise<{ url: string; applied: boolean }> {
  const user = await usersRepo.findById(input.userId);
  if (!user) throw AppError.notFound('user');

  // The owner already has the top plan. Sending them to a payment page would
  // take money for something they cannot be charged for and cannot lose.
  if (isOwnerEmail(user.email)) {
    throw AppError.conflict(
      'This account already has full access and does not need a subscription.',
      'هذا الحساب يملك جميع الصلاحيات بالفعل ولا يحتاج اشتراكًا.',
    );
  }

  const provider = billingProvider();
  const result = await provider.createCheckout({
    userId: input.userId,
    email: user.email,
    planCode: input.planCode,
    locale: input.locale,
  });

  logger.info('billing.checkout.started', {
    provider: provider.name,
    planCode: input.planCode,
    applied: result.applied,
  });

  return result;
}

export async function openPortal(userId: string, locale: string): Promise<{ url: string }> {
  return billingProvider().createPortalSession({ userId, locale });
}

export async function cancelSubscription(userId: string, atPeriodEnd: boolean): Promise<void> {
  await billingProvider().cancel({ userId, atPeriodEnd });
  logger.info('billing.subscription.canceled', { atPeriodEnd });
}

export async function listUserPayments(userId: string) {
  return paymentsRepo.listByUser(userId);
}

/**
 * The outcome of a webhook, as far as the transport layer needs to know.
 *
 * `unmatched` matters: PayPal delivers the first sale of a subscription and the
 * activation in no guaranteed order, so a sale can arrive before the account is
 * linked. Answering 200 to that would drop the payment permanently — it must be
 * reported as a failure so the gateway redelivers.
 */
export type BillingEventOutcome = 'applied' | 'ignored' | 'unmatched';

/**
 * Resolves the account an event belongs to.
 *
 * PayPal puts `custom_id` on subscription events but not on sale events, and
 * refund payloads carry neither — only the id of the charge being reversed. All
 * three routes are tried before giving up.
 */
async function resolveUserId(event: BillingEvent): Promise<string | undefined> {
  if (event.userId) return event.userId;

  if (event.externalSubscriptionId) {
    const bySubscription = await plansRepo.findSubscriptionByExternalId(
      event.externalSubscriptionId,
    );
    if (bySubscription) return bySubscription.subscription.userId;
  }

  if (event.relatedPaymentId) {
    const original = await paymentsRepo.findByExternalPaymentId(event.relatedPaymentId);
    if (original) return original.userId;
  }

  return undefined;
}

function monthAfter(from: Date): Date {
  const next = new Date(from);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  // Clamp rather than overflow: 31 January + 1 month is 28 February, not 3 March.
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

/** Applies a verified provider event to the database. Idempotent by design. */
export async function applyBillingEvent(event: BillingEvent): Promise<BillingEventOutcome> {
  if (event.type === 'ignored') return 'ignored';

  const userId = await resolveUserId(event);
  if (!userId) {
    logger.warn('billing.webhook.unmatched', {
      type: event.type,
      externalSubscriptionId: event.externalSubscriptionId,
      relatedPaymentId: event.relatedPaymentId,
    });
    return 'unmatched';
  }

  const provider = billingProvider();
  const existing = await plansRepo.findSubscriptionByUser(userId);

  /* ---------------------------- money movements --------------------------- */

  if (event.payment && event.type !== 'payment.failed') {
    await paymentsRepo.record({
      userId,
      subscriptionId: existing?.subscription.id ?? null,
      planCode: event.planCode ?? existing?.plan.code ?? null,
      provider: provider.name,
      status: event.type === 'payment.refunded' ? 'REFUNDED' : 'SUCCEEDED',
      amountCents: event.payment.amountCents,
      currency: event.payment.currency,
      externalPaymentId: event.payment.externalPaymentId,
      externalSubscriptionId: event.externalSubscriptionId ?? null,
      externalEventId: event.externalEventId ?? null,
      occurredAt: event.payment.occurredAt,
    });
  }

  /* ------------------------------ lifecycle ------------------------------- */

  if (event.type === 'subscription.canceled') {
    if (existing) {
      // Time already paid for is honoured: the downgrade lands when the period
      // ends (see `resolvePlanForUser`), not the moment PayPal says "cancelled".
      // An immediate cancellation has already downgraded the row and cleared the
      // gateway id, so `plan.priceCents` is zero here and nothing is extended.
      const stillPaidFor =
        existing.plan.priceCents > 0 &&
        existing.subscription.periodEnd !== null &&
        existing.subscription.periodEnd.getTime() > Date.now();

      await plansRepo.updateSubscription(existing.subscription.id, {
        status: 'CANCELED',
        canceledAt: existing.subscription.canceledAt ?? new Date(),
        cancelAtPeriodEnd: stillPaidFor,
      });
    }
    return 'applied';
  }

  if (event.type === 'payment.failed') {
    // Deliberately grants and extends nothing: a failed payment must never be a
    // path to Pro. PayPal retries, and a later success re-activates.
    if (existing) {
      await plansRepo.updateSubscription(existing.subscription.id, { status: 'PAST_DUE' });
    }

    // Keyed on the event id when there is no payment id, so PayPal's retries of
    // the same failure do not pile up as separate rows in the user's history.
    await paymentsRepo.record({
      userId,
      subscriptionId: existing?.subscription.id ?? null,
      planCode: existing?.plan.code ?? null,
      provider: provider.name,
      status: 'FAILED',
      // Never invented: PayPal does not quote an amount on a failure notice.
      amountCents: event.payment?.amountCents ?? 0,
      currency: event.payment?.currency ?? existing?.plan.currency ?? 'USD',
      externalPaymentId: event.payment?.externalPaymentId ?? event.externalEventId ?? null,
      externalSubscriptionId: event.externalSubscriptionId ?? null,
      externalEventId: event.externalEventId ?? null,
      occurredAt: event.payment?.occurredAt ?? new Date(),
    });
    return 'applied';
  }

  if (event.type === 'payment.refunded') {
    if (existing) {
      await plansRepo.updateSubscription(existing.subscription.id, { status: 'PAST_DUE' });
    }
    return 'applied';
  }

  if (event.type === 'subscription.updated' && (event.providerStatus ?? '').toUpperCase() !== 'ACTIVE') {
    // A change the gateway does not call ACTIVE — a suspended subscriber editing
    // their funding source, say. Recording it would restore paid access for free.
    logger.info('billing.webhook.updated_not_active', { status: event.providerStatus });
    return 'ignored';
  }

  /* ------------------- activation, renewal and plan change ---------------- */

  const plan = event.planCode
    ? await plansRepo.findPlanByCode(event.planCode)
    : (existing?.plan ?? (await plansRepo.findDefaultPlan()));

  if (!plan) return 'ignored';

  if (plan.priceCents === 0) {
    // A charge landed but the only plan we can attribute it to is the free one.
    // Writing ACTIVE-on-free here is how a paying customer silently loses Pro,
    // so the money is kept in the ledger and a human is told instead.
    logger.error('billing.webhook.paid_event_on_free_plan', {
      type: event.type,
      userId,
      externalSubscriptionId: event.externalSubscriptionId,
    });
    return 'applied';
  }

  // A renewal payment carries no next-billing date, so the period is rolled
  // forward a month from the payment itself rather than left to expire.
  const renewalEnd =
    event.type === 'payment.succeeded' && !event.periodEnd
      ? monthAfter(event.payment?.occurredAt ?? new Date())
      : undefined;

  const periodEnd = event.periodEnd ?? renewalEnd ?? existing?.subscription.periodEnd ?? null;
  const changingPlan = existing?.subscription.planId !== plan.id;

  const values = {
    planId: plan.id,
    status: 'ACTIVE' as const,
    periodStart: changingPlan ? new Date() : (existing?.subscription.periodStart ?? new Date()),
    periodEnd,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    provider: provider.name,
    externalCustomerId:
      event.externalCustomerId ?? existing?.subscription.externalCustomerId ?? null,
    externalSubscriptionId:
      event.externalSubscriptionId ?? existing?.subscription.externalSubscriptionId ?? null,
  };

  if (existing) {
    await plansRepo.updateSubscription(existing.subscription.id, values);
  } else {
    // `ensureSubscription` absorbs a conflict and returns whatever row won the
    // race — which, when the user's browser resolved their plan while this
    // webhook was in flight, is a free-plan row. Updating it afterwards is what
    // stops a paid activation from being silently discarded.
    const row = await plansRepo.ensureSubscription({ userId, ...values });
    await plansRepo.updateSubscription(row.id, values);
  }

  logger.info('billing.subscription.applied', {
    type: event.type,
    planCode: plan.code,
    provider: provider.name,
  });

  return 'applied';
}

/**
 * Confirms an approval directly with PayPal when the subscriber returns.
 *
 * PayPal appends `subscription_id` to the return URL, so the application can
 * ask what the outcome was rather than waiting for a webhook that may be
 * delayed, misconfigured, or never registered. Ownership is checked against the
 * `custom_id` PayPal itself stores, so a guessed or borrowed id cannot activate
 * somebody else's account — and only a subscription PayPal reports as ACTIVE
 * grants anything.
 */
export async function reconcileCheckout(input: {
  userId: string;
  subscriptionId: string;
}): Promise<'activated' | 'pending' | 'ignored'> {
  const provider = billingProvider();
  if (!(provider instanceof PayPalBillingProvider)) return 'ignored';

  let remote: Awaited<ReturnType<PayPalBillingProvider['fetchSubscription']>>;
  try {
    remote = await provider.fetchSubscription(input.subscriptionId);
  } catch (error) {
    logger.warn('billing.reconcile.failed', {
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
    });
    return 'ignored';
  }

  if (remote.userId !== input.userId) {
    logger.warn('billing.reconcile.owner_mismatch', { subscriptionId: input.subscriptionId });
    return 'ignored';
  }

  if ((remote.status ?? '').toUpperCase() !== 'ACTIVE') return 'pending';

  await applyBillingEvent({
    type: 'subscription.activated',
    providerStatus: remote.status,
    userId: input.userId,
    planCode: remote.planCode,
    externalSubscriptionId: remote.id ?? input.subscriptionId,
    externalCustomerId: remote.payerId,
    periodEnd: remote.nextBillingTime,
    externalEventId: `return-${input.subscriptionId}`,
  });

  logger.info('billing.reconcile.activated', { planCode: remote.planCode });
  return 'activated';
}
