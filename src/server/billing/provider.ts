/**
 * Payment gateways sit behind one interface so the subscription flow can ship,
 * and be tested, before a gateway account exists.
 *
 * `ManualBillingProvider` runs the entire upgrade / cancel flow against the
 * database. `PayPalBillingProvider` and `StripeBillingProvider` implement the
 * same methods against their APIs. Nothing outside this folder knows which one
 * is active.
 */

export type BillingProviderName = 'manual' | 'stripe' | 'paypal';

export interface CheckoutResult {
  /** Where to send the user next. Manual billing returns an internal URL. */
  url: string;
  /** True when the plan change already happened (manual billing). */
  applied: boolean;
}

export type BillingEventType =
  | 'subscription.activated'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.refunded'
  | 'ignored';

/** A money movement worth writing to the ledger, in minor units. */
export interface BillingPayment {
  externalPaymentId: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

export interface BillingEvent {
  type: BillingEventType;
  /**
   * The gateway's own status for the subscription, verbatim.
   *
   * PayPal emits `BILLING.SUBSCRIPTION.UPDATED` for changes that do **not**
   * mean "paid" — a suspended subscriber editing their funding source, for one.
   * Access is granted only when the gateway itself says ACTIVE.
   */
  providerStatus?: string;
  /** The provider's own event id — used to make webhook handling idempotent. */
  externalEventId?: string;
  externalCustomerId?: string;
  externalSubscriptionId?: string;
  planCode?: string;
  periodEnd?: Date;
  userId?: string;
  payment?: BillingPayment;
  /**
   * For refunds and reversals: the id of the original charge. It is the only
   * link back to the account, since refund payloads carry no subscription id.
   */
  relatedPaymentId?: string;
}

export interface BillingProvider {
  readonly name: BillingProviderName;

  /** True when the provider has the credentials it needs. */
  isConfigured(): boolean;

  /** True when this provider can bill a real card. */
  readonly takesRealPayments: boolean;

  createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    locale: string;
  }): Promise<CheckoutResult>;

  createPortalSession(input: { userId: string; locale: string }): Promise<{ url: string }>;

  cancel(input: { userId: string; atPeriodEnd: boolean }): Promise<void>;

  /**
   * Verifies authenticity and maps the payload onto a `BillingEvent`.
   *
   * Takes the full header set rather than one signature string: PayPal spreads
   * its signature across five headers, and a verified webhook is the only thing
   * standing between an attacker and a free Pro subscription.
   */
  handleWebhook(rawBody: string, headers: Headers): Promise<BillingEvent>;
}
