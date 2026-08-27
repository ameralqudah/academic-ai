import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

import { ManualBillingProvider } from './manual';
import { PayPalBillingProvider } from './paypal';
import type { BillingProvider } from './provider';
import { StripeBillingProvider } from './stripe';

let cached: BillingProvider | null = null;

export function billingProvider(): BillingProvider {
  if (cached) return cached;

  const env = getEnv();

  if (env.BILLING_PROVIDER === 'paypal') {
    const paypal = new PayPalBillingProvider();
    if (paypal.isConfigured()) {
      cached = paypal;
      return cached;
    }
    logger.warn('billing.paypal.unconfigured', {
      detail:
        'BILLING_PROVIDER=paypal but PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty — falling back to manual.',
    });
  }

  if (env.BILLING_PROVIDER === 'stripe') {
    const stripe = new StripeBillingProvider();
    if (stripe.isConfigured()) {
      cached = stripe;
      return cached;
    }
    logger.warn('billing.stripe.unconfigured', {
      detail: 'BILLING_PROVIDER=stripe but STRIPE_SECRET_KEY is empty — falling back to manual.',
    });
  }

  cached = new ManualBillingProvider();
  return cached;
}

/** Test seam: the provider is cached per process, so config changes need a reset. */
export function resetBillingProvider(): void {
  cached = null;
}

export type {
  BillingEvent,
  BillingPayment,
  BillingProvider,
  BillingProviderName,
  CheckoutResult,
} from './provider';
