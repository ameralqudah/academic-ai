import { createHmac, timingSafeEqual } from 'node:crypto';

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import * as plansRepo from '@/server/repositories/plans.repository';

import type { BillingEvent, BillingProvider, CheckoutResult } from './provider';

const API = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Implemented against Stripe's REST API with `fetch` rather than the SDK — the
 * same choice made for the AI providers: fewer dependencies, and the payload
 * shapes stay visible in the code that depends on them.
 *
 * Nothing here activates until STRIPE_SECRET_KEY is set.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe' as const;
  readonly takesRealPayments = true;

  private get secretKey(): string {
    return getEnv().STRIPE_SECRET_KEY ?? '';
  }

  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  private async call<T>(path: string, form: Record<string, string>): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });

    if (!response.ok) {
      const detail = await response.text();
      logger.error('stripe.request.failed', { path, status: response.status });
      throw AppError.conflict(
        `Payment provider error: ${detail.slice(0, 200)}`,
        'حدث خطأ لدى مزوّد الدفع. حاول مرة أخرى.',
      );
    }

    return (await response.json()) as T;
  }

  private baseUrl(): string {
    const env = getEnv();
    return env.AUTH_URL?.replace(/\/$/, '') ?? 'http://localhost:3000';
  }

  async createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    locale: string;
  }): Promise<CheckoutResult> {
    const env = getEnv();
    const plan = await plansRepo.findPlanByCode(input.planCode);
    if (!plan?.isActive) throw AppError.notFound('plan');

    const priceId = plan.externalPriceId ?? env.STRIPE_PRO_PRICE_ID;
    if (!priceId) {
      throw AppError.conflict(
        'This plan has no price configured with the payment provider.',
        'هذه الخطة غير مربوطة بسعر لدى مزوّد الدفع.',
      );
    }

    const session = await this.call<{ url: string }>('/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      customer_email: input.email,
      client_reference_id: input.userId,
      'metadata[userId]': input.userId,
      'metadata[planCode]': plan.code,
      'subscription_data[metadata][userId]': input.userId,
      'subscription_data[metadata][planCode]': plan.code,
      success_url: `${this.baseUrl()}/${input.locale}/billing?checkout=success`,
      cancel_url: `${this.baseUrl()}/${input.locale}/billing?checkout=cancelled`,
      locale: input.locale === 'ar' ? 'ar' : 'en',
    });

    return { url: session.url, applied: false };
  }

  async createPortalSession(input: { userId: string; locale: string }): Promise<{ url: string }> {
    const existing = await plansRepo.findSubscriptionByUser(input.userId);
    const customerId = existing?.subscription.externalCustomerId;
    if (!customerId) {
      throw AppError.conflict(
        'This account has no payment provider customer yet.',
        'لا يوجد لهذا الحساب سجل لدى مزوّد الدفع بعد.',
      );
    }

    const session = await this.call<{ url: string }>('/billing_portal/sessions', {
      customer: customerId,
      return_url: `${this.baseUrl()}/${input.locale}/billing`,
    });

    return { url: session.url };
  }

  async cancel(input: { userId: string; atPeriodEnd: boolean }): Promise<void> {
    const existing = await plansRepo.findSubscriptionByUser(input.userId);
    const subscriptionId = existing?.subscription.externalSubscriptionId;
    if (!subscriptionId) throw AppError.notFound('subscription');

    if (input.atPeriodEnd) {
      await this.call(`/subscriptions/${subscriptionId}`, { cancel_at_period_end: 'true' });
    } else {
      await fetch(`${API}/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.secretKey}` },
      });
    }
  }

  /** Constant-time verification of Stripe's `t=…,v1=…` signature header. */
  private verify(rawBody: string, signature: string | null): void {
    const secret = getEnv().STRIPE_WEBHOOK_SECRET;
    if (!secret) throw AppError.forbidden();
    if (!signature) throw AppError.forbidden();

    const parts = Object.fromEntries(
      signature.split(',').map((part) => {
        const [key, value] = part.split('=');
        return [key?.trim() ?? '', value?.trim() ?? ''];
      }),
    );

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) throw AppError.forbidden();
    if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
      throw AppError.forbidden();
    }

    const expected = createHmac('sha256', secret)
      .update(`${parts.t}.${rawBody}`)
      .digest('hex');

    const provided = parts.v1 ?? '';
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      throw AppError.forbidden();
    }
  }

  async handleWebhook(rawBody: string, headers: Headers): Promise<BillingEvent> {
    this.verify(rawBody, headers.get('stripe-signature'));

    const event = JSON.parse(rawBody) as {
      id?: string;
      type: string;
      data: {
        object: {
          id?: string;
          customer?: string;
          subscription?: string;
          status?: string;
          current_period_end?: number;
          client_reference_id?: string;
          metadata?: { userId?: string; planCode?: string };
        };
      };
    };

    const object = event.data.object;
    const userId = object.metadata?.userId ?? object.client_reference_id;
    const periodEnd = object.current_period_end
      ? new Date(object.current_period_end * 1000)
      : undefined;

    switch (event.type) {
      case 'checkout.session.completed':
      case 'customer.subscription.created':
        return {
          type: 'subscription.activated',
          userId,
          planCode: object.metadata?.planCode,
          externalCustomerId: object.customer,
          externalSubscriptionId: object.subscription ?? object.id,
          periodEnd,
        };
      case 'customer.subscription.updated':
        return {
          type: 'subscription.updated',
          userId,
          planCode: object.metadata?.planCode,
          externalCustomerId: object.customer,
          externalSubscriptionId: object.id,
          periodEnd,
        };
      case 'customer.subscription.deleted':
        return {
          type: 'subscription.canceled',
          userId,
          externalCustomerId: object.customer,
          externalSubscriptionId: object.id,
        };
      case 'invoice.payment_succeeded':
        return {
          type: 'payment.succeeded',
          userId,
          externalCustomerId: object.customer,
          externalSubscriptionId: object.subscription,
        };
      case 'invoice.payment_failed':
        return {
          type: 'payment.failed',
          userId,
          externalCustomerId: object.customer,
          externalSubscriptionId: object.subscription,
        };
      default:
        return { type: 'ignored' };
    }
  }
}
