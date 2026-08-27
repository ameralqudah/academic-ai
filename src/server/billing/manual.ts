import { getEnv } from '@/config/env';
import { AppError } from '@/server/http/errors';
import * as plansRepo from '@/server/repositories/plans.repository';

import type { BillingEvent, BillingProvider, CheckoutResult } from './provider';

/**
 * Applies plan changes directly in the database.
 *
 * This is what runs until a real gateway is connected: the whole subscription
 * experience — upgrade, downgrade, cancel, limits, usage reset — is real, only
 * the payment step is skipped. Never enable this in production.
 */
export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual' as const;
  readonly takesRealPayments = false;

  isConfigured(): boolean {
    return true;
  }

  async createCheckout(input: {
    userId: string;
    planCode: string;
    locale: string;
  }): Promise<CheckoutResult> {
    const plan = await plansRepo.findPlanByCode(input.planCode);
    if (!plan?.isActive) {
      throw AppError.notFound('plan');
    }

    // Without this, a production deployment whose Stripe key is missing or
    // rotated would hand every authenticated user a free Pro upgrade.
    const env = getEnv();
    if (
      plan.priceCents > 0 &&
      env.NODE_ENV === 'production' &&
      !env.MANUAL_BILLING_ALLOW_PAID
    ) {
      throw AppError.conflict(
        'Paid plans are unavailable: no payment provider is configured. Set BILLING_PROVIDER=paypal (or stripe) with valid keys, or MANUAL_BILLING_ALLOW_PAID=true to grant paid plans without charging.',
        'الخطط المدفوعة غير متاحة: لا توجد بوابة دفع مُعدّة. اضبط BILLING_PROVIDER=paypal بمفاتيح صحيحة.',
      );
    }

    const existing = await plansRepo.findSubscriptionByUser(input.userId);
    const periodEnd = new Date();
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

    if (existing) {
      await plansRepo.updateSubscription(existing.subscription.id, {
        planId: plan.id,
        status: 'ACTIVE',
        periodStart: new Date(),
        periodEnd,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        provider: 'manual',
      });
    } else {
      await plansRepo.createSubscription({
        userId: input.userId,
        planId: plan.id,
        status: 'ACTIVE',
        periodEnd,
        provider: 'manual',
      });
    }

    return { url: `/${input.locale}/billing?changed=1`, applied: true };
  }

  async createPortalSession(input: { locale: string }): Promise<{ url: string }> {
    return { url: `/${input.locale}/billing` };
  }

  async cancel(input: { userId: string; atPeriodEnd: boolean }): Promise<void> {
    const existing = await plansRepo.findSubscriptionByUser(input.userId);
    if (!existing) throw AppError.notFound('subscription');

    if (input.atPeriodEnd) {
      await plansRepo.updateSubscription(existing.subscription.id, {
        cancelAtPeriodEnd: true,
        canceledAt: new Date(),
      });
      return;
    }

    const fallback = await plansRepo.findDefaultPlan();
    if (!fallback) throw AppError.notFound('plan');

    await plansRepo.updateSubscription(existing.subscription.id, {
      planId: fallback.id,
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
      periodEnd: null,
    });
  }

  async handleWebhook(): Promise<BillingEvent> {
    return { type: 'ignored' };
  }
}
