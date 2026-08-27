import type { SubscriptionPlan } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as plansRepo from '@/server/repositories/plans.repository';
import * as usersRepo from '@/server/repositories/users.repository';
import { isOwnerEmail, ownerOverrideEnabled } from '@/server/auth/owner';

export const UNLIMITED = -1;

/** Renewal webhooks can be minutes late; access should not flicker. */
const LAPSE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export interface ResolvedPlan {
  plan: SubscriptionPlan;
  status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED';
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  isPro: boolean;
  /** True when access comes from the owner override rather than a subscription. */
  isOwner: boolean;
}

/**
 * Every user always has a plan. If a subscription row is missing (social sign-in,
 * data imported from elsewhere), the default plan is attached on read rather than
 * leaving the caller to handle a null.
 */
export async function resolvePlanForUser(userId: string): Promise<ResolvedPlan> {
  // The owner runs the product and is not a customer of it. Resolving the plan
  // here — the one function every limit, guard and paid feature already calls —
  // means the override needs no special case anywhere else, and no subscription
  // row, payment or gateway involvement of any kind.
  const owner = await ownerPlan(userId);
  if (owner) return owner;

  const existing = await plansRepo.findSubscriptionByUser(userId);

  if (existing) {
    const { plan, subscription } = existing;

    // A paid period that ran out — the gateway cancelled, a renewal never came
    // through, or a webhook was lost — must not keep granting Pro. The check
    // runs on read so no scheduled job is needed for the plan to lapse, and a
    // short grace absorbs normal webhook delay around the renewal moment.
    const lapsed =
      plan.priceCents > 0 &&
      subscription.periodEnd !== null &&
      subscription.periodEnd.getTime() + LAPSE_GRACE_MS < Date.now();

    if (lapsed) {
      const fallback = await plansRepo.findDefaultPlan();
      if (fallback) {
        // The row keeps pointing at the paid plan on purpose. A renewal that
        // arrives late — a retried card, a webhook delayed past the grace —
        // must be able to restore Pro, and it can only do that if the record
        // of *which* plan was paid for survives the lapse. Access is withheld
        // by what this function returns, not by rewriting history.
        if (subscription.status !== 'CANCELED') {
          await plansRepo.updateSubscription(subscription.id, {
            status: 'CANCELED',
            canceledAt: subscription.canceledAt ?? new Date(),
          });
        }

        return {
          plan: fallback,
          status: 'CANCELED',
          periodEnd: subscription.periodEnd,
          cancelAtPeriodEnd: false,
          isPro: false,
          isOwner: false,
        };
      }
    }

    const orphanedCancel = subscription.status === 'CANCELED' && subscription.periodEnd === null;

    return {
      plan,
      status: subscription.status,
      periodEnd: subscription.periodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      isPro: plan.priceCents > 0 && !orphanedCancel,
      isOwner: false,
    };
  }

  const fallback = await plansRepo.findDefaultPlan();
  if (!fallback) {
    throw new AppError(
      'INTERNAL',
      'No default subscription plan is configured. Run the database seed.',
      'لا توجد خطة اشتراك افتراضية. شغّل ملف البذور (seed).',
    );
  }

  await plansRepo.ensureSubscription({ userId, planId: fallback.id, status: 'ACTIVE' });

  return {
    plan: fallback,
    status: 'ACTIVE',
    periodEnd: null,
    cancelAtPeriodEnd: false,
    isPro: false,
    isOwner: false,
  };
}

/**
 * The owner's plan: the top plan, permanently, with no period and no gateway.
 *
 * Returns `null` for everyone else, so a single `if` at the top of plan
 * resolution is the entire surface of this feature. Nothing about paying
 * customers, PayPal, webhooks or limits changes.
 */
async function ownerPlan(userId: string): Promise<ResolvedPlan | null> {
  if (!ownerOverrideEnabled()) return null;

  const user = await usersRepo.findById(userId);
  if (!isOwnerEmail(user?.email)) return null;

  const plan = (await plansRepo.findTopPlan()) ?? (await plansRepo.findDefaultPlan());
  if (!plan) return null;

  return {
    plan,
    status: 'ACTIVE',
    // No end date: there is nothing to renew and nothing to lapse.
    periodEnd: null,
    cancelAtPeriodEnd: false,
    isPro: plan.priceCents > 0,
    isOwner: true,
  };
}

export async function attachDefaultPlan(userId: string): Promise<void> {
  const fallback = await plansRepo.findDefaultPlan();
  if (!fallback) return;
  await plansRepo.ensureSubscription({ userId, planId: fallback.id, status: 'ACTIVE' });
}

/** `-1` means unlimited everywhere in the app. */
export function isUnlimited(limit: number): boolean {
  return limit === UNLIMITED;
}

export function hasToolAccess(plan: SubscriptionPlan, key: string): boolean {
  const access = plan.toolAccess ?? {};
  return access[key] === true;
}

export async function listPublicPlans() {
  return plansRepo.listActivePlans();
}
