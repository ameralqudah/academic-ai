import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import * as appSettingsRepo from '@/server/repositories/app-settings.repository';
import * as plansRepo from '@/server/repositories/plans.repository';

import type { BillingEvent, BillingProvider, CheckoutResult } from './provider';

const LIVE = 'https://api-m.paypal.com';
const SANDBOX = 'https://api-m.sandbox.paypal.com';

/** Refresh a little before PayPal's own expiry so a request never races it. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

interface SubscriptionResource {
  id?: string;
  status?: string;
  custom_id?: string;
  plan_id?: string;
  subscriber?: { payer_id?: string; email_address?: string };
  billing_info?: { next_billing_time?: string };
  links?: PayPalLink[];
}

interface SaleResource {
  id?: string;
  custom?: string;
  custom_id?: string;
  billing_agreement_id?: string;
  /** Refund payloads point back at the charge they reverse. */
  sale_id?: string;
  parent_payment?: string;
  create_time?: string;
  amount?: { total?: string; currency?: string; value?: string; currency_code?: string };
}

/**
 * Currencies PayPal bills in whole units. Sending `"10.00"` for these is
 * rejected outright with DECIMALS_NOT_SUPPORTED, which would break checkout for
 * every subscriber rather than degrade quietly.
 */
/** Exactly the events the subscription lifecycle depends on. */
const WEBHOOK_EVENTS = [
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.DENIED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
] as const;

const ZERO_DECIMAL_CURRENCIES = new Set(['HUF', 'JPY', 'TWD']);

function minorUnitFactor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

/** Minor units (what the database stores) to the string PayPal expects. */
function toGatewayAmount(minorUnits: number, currency: string): string {
  const factor = minorUnitFactor(currency);
  return factor === 1 ? String(Math.round(minorUnits)) : (minorUnits / factor).toFixed(2);
}

/** The inverse: PayPal's decimal string back to minor units. */
function toMinorUnits(value: number, currency: string): number {
  return Math.round(value * minorUnitFactor(currency));
}

/**
 * PayPal Subscriptions, implemented against the REST API with `fetch` — the same
 * choice made for the AI providers: no SDK, and the payload shapes stay visible
 * in the code that depends on them.
 *
 * Two decisions worth knowing about:
 *
 * 1. The Pro plan is provisioned on first use from the price already stored in
 *    the database, and its PayPal id is cached in `app_settings`. That keeps one
 *    source of truth for the price and spares the operator a manual dashboard
 *    step that is easy to get wrong.
 * 2. `custom_id` carries `userId:planCode`. PayPal echoes it back on every
 *    webhook, so activation never depends on a lookup table that could drift.
 */
export class PayPalBillingProvider implements BillingProvider {
  readonly name = 'paypal' as const;

  /**
   * Whether money actually moves.
   *
   * Not a property of the provider but of the environment it is pointed at:
   * a sandbox deployment runs the identical code, returns the identical
   * "subscription active", and moves nothing. Reporting `true` there is how an
   * operator ends up believing they are open for business while every payment
   * is a simulation, so this follows the environment in use.
   */
  get takesRealPayments(): boolean {
    return this.environmentInUse() === 'live';
  }

  private token: { value: string; expiresAt: number } | null = null;
  private detectedApi: string | null = null;

  /**
   * Trimmed on the way in. Credentials are copied by hand out of PayPal's
   * dashboard and pasted into a hosting panel; a trailing newline or space is
   * one of the most common reasons for an otherwise inexplicable 401.
   */
  private get credentials(): { clientId: string; secret: string } {
    const env = getEnv();
    const clean = (value: string | undefined) =>
      (value ?? '').trim().replace(/^["']|["']$/g, '');

    return { clientId: clean(env.PAYPAL_CLIENT_ID), secret: clean(env.PAYPAL_CLIENT_SECRET) };
  }

  private get configuredApi(): string {
    return getEnv().PAYPAL_ENVIRONMENT === 'sandbox' ? SANDBOX : LIVE;
  }

  /** The endpoint actually in use — see `accessToken` for when these differ. */
  private get api(): string {
    return this.detectedApi ?? this.configuredApi;
  }

  /** Which environment the working credentials belong to, once known. */
  environmentInUse(): 'sandbox' | 'live' {
    return this.api === SANDBOX ? 'sandbox' : 'live';
  }

  /** Which environment the deployment was *told* to use. */
  configuredEnvironment(): 'sandbox' | 'live' {
    return this.configuredApi === SANDBOX ? 'sandbox' : 'live';
  }

  /**
   * Asked for live, running on sandbox.
   *
   * The fallback in `accessToken` keeps the application working instead of
   * crashing, which is right — but it also makes the failure quiet, and a quiet
   * version of "you believe you are taking money and you are not" is the worst
   * possible outcome. So it is reported as a problem, not just logged.
   */
  environmentMismatch(): boolean {
    return this.configuredEnvironment() === 'live' && this.environmentInUse() === 'sandbox';
  }

  isConfigured(): boolean {
    const { clientId, secret } = this.credentials;
    return clientId.length > 0 && secret.length > 0;
  }

  /* ------------------------------------------------------------------ */
  /*                              Transport                             */
  /* ------------------------------------------------------------------ */

  /** One token request. Returns the token, or the HTTP status that refused it. */
  private async requestToken(
    api: string,
  ): Promise<{ value: string; expiresIn: number } | number> {
    const { clientId, secret } = this.credentials;
    const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');

    const response = await fetch(`${api}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) return response.status;

    const body = (await response.json()) as { access_token: string; expires_in: number };
    return { value: body.access_token, expiresIn: body.expires_in };
  }

  /**
   * Authenticates, and rescues the single most common misconfiguration.
   *
   * Sandbox and live credentials are indistinguishable by eye and live on two
   * near-identical dashboard pages, so pointing live-configured keys at the
   * sandbox endpoint (or the reverse) is easy and produces nothing but a bare
   * 401. When the configured environment refuses the keys, the other one is
   * tried once.
   *
   * The rescue is deliberately one-way: falling back to **sandbox** is safe,
   * because no real money can move there. Silently escalating sandbox-configured
   * keys to the live endpoint would charge real cards during what the operator
   * believes is a test, so that direction fails loudly instead.
   */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    if (!this.isConfigured()) {
      throw AppError.conflict(
        'PayPal credentials are not set. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.',
        'بيانات اعتماد PayPal غير مضبوطة.',
      );
    }

    const primary = this.api;
    let result = await this.requestToken(primary);

    if (typeof result === 'number' && result === 401 && primary === LIVE) {
      const retry = await this.requestToken(SANDBOX);
      if (typeof retry !== 'number') {
        logger.error('paypal.environment.mismatch', {
          detail:
            'PAYPAL_ENVIRONMENT is "live" but these credentials belong to the sandbox. Using sandbox — no real payments will be taken. Set PAYPAL_ENVIRONMENT=sandbox, or paste the credentials from the Live dashboard.',
        });
        this.detectedApi = SANDBOX;
        result = retry;
      }
    }

    if (typeof result === 'number') {
      // Distinguish "wrong environment" from "wrong keys": if the live endpoint
      // accepts them while sandbox is configured, say so rather than switching.
      let hint = 'Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.';
      let hintAr = 'تحقّق من صحة PAYPAL_CLIENT_ID و PAYPAL_CLIENT_SECRET.';

      if (result === 401 && primary === SANDBOX) {
        const live = await this.requestToken(LIVE);
        if (typeof live !== 'number') {
          hint =
            'These are LIVE credentials but PAYPAL_ENVIRONMENT is "sandbox". They were not used, because that would charge real cards. Set PAYPAL_ENVIRONMENT=live, or paste the sandbox credentials.';
          hintAr =
            'هذه مفاتيح Live بينما PAYPAL_ENVIRONMENT=sandbox. لم تُستخدم تفاديًا لخصم أموال حقيقية. اضبط PAYPAL_ENVIRONMENT=live أو الصق مفاتيح Sandbox.';
        }
      }

      logger.error('paypal.token.failed', { status: result, environment: this.environmentInUse(), hint });
      throw AppError.conflict(`PayPal rejected the credentials (${result}). ${hint}`, hintAr);
    }

    this.token = {
      value: result.value,
      expiresAt: Date.now() + result.expiresIn * 1000 - TOKEN_SAFETY_MARGIN_MS,
    };
    return this.token.value;
  }

  /**
   * Settles which environment is really in use, then reports it.
   *
   * `environmentInUse()` can only answer honestly once a token has been
   * requested: before that it repeats what the configuration claims, which is
   * exactly the claim in doubt. Anything that *displays* the environment — the
   * admin dashboard above all — has to force the detection first, or it will
   * cheerfully print "live" on a deployment that is running on sandbox.
   *
   * The token is cached, so this costs one call per token lifetime at most.
   */
  async resolvedEnvironment(): Promise<{
    environment: 'sandbox' | 'live';
    mismatch: boolean;
    authenticated: boolean;
  }> {
    let authenticated = false;
    try {
      await this.accessToken();
      authenticated = true;
    } catch {
      authenticated = false;
    }
    return {
      environment: this.environmentInUse(),
      mismatch: this.environmentMismatch(),
      authenticated,
    };
  }

  /**
   * A single authentication attempt for the health endpoint: does this
   * deployment actually have working PayPal credentials, and for which
   * environment? Never throws — the caller reports, it does not fail.
   */
  /**
   * A safe fingerprint of the configured credentials.
   *
   * A 401 says only "no". These fields say *why* without ever revealing the
   * secret: its length and whether it is even shaped like a secret. The client
   * id prefix is safe to show — PayPal puts the whole client id in browser-side
   * SDK URLs — while the secret is described, never quoted.
   *
   * Sandbox and live credentials are ~80 characters; ids begin with `A`, secrets
   * with `E`. `identical: true` is the classic mistake: the client id pasted
   * into both fields because the secret sits behind a "Show" button.
   */
  private fingerprint() {
    const { clientId, secret } = this.credentials;
    return {
      clientIdLength: clientId.length,
      clientIdPrefix: clientId.slice(0, 6),
      clientIdLooksRight: /^A[A-Za-z0-9_-]{20,}$/.test(clientId),
      secretLength: secret.length,
      secretLooksRight: /^E[A-Za-z0-9_-]{20,}$/.test(secret),
      identical: clientId.length > 0 && clientId === secret,
      containsWhitespace: /\s/.test(clientId) || /\s/.test(secret),
    };
  }

  /**
   * A single authentication attempt for the health endpoint: does this
   * deployment actually have working PayPal credentials, and for which
   * environment? Never throws — the caller reports, it does not fail.
   */
  async diagnose(): Promise<{
    configured: boolean;
    authenticated: boolean;
    environment: 'sandbox' | 'live';
    configuredEnvironment: 'sandbox' | 'live';
    mismatch: boolean;
    credentials: ReturnType<PayPalBillingProvider['fingerprint']>;
    webhook?: { url: string; id?: string; detail?: string };
    detail?: string;
  }> {
    const environment = this.environmentInUse();
    const credentials = this.fingerprint();

    if (!this.isConfigured()) {
      return {
        configured: false,
        authenticated: false,
        environment,
        configuredEnvironment: this.configuredEnvironment(),
        mismatch: false,
        credentials,
        detail: 'PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is empty.',
      };
    }

    try {
      await this.accessToken();

      // Registering the webhook is part of being "ready", so the health check
      // both reports it and, on a fresh deployment, causes it to happen.
      let webhook: { url: string; id?: string; detail?: string } = { url: this.webhookUrl() };
      try {
        webhook = { url: this.webhookUrl(), id: await this.ensureWebhookId() };
      } catch (error) {
        webhook = {
          url: this.webhookUrl(),
          detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
        };
      }

      return {
        configured: true,
        authenticated: true,
        environment: this.environmentInUse(),
        configuredEnvironment: this.configuredEnvironment(),
        mismatch: this.environmentMismatch(),
        credentials,
        webhook,
      };
    } catch (error) {
      return {
        configured: true,
        authenticated: false,
        environment: this.environmentInUse(),
        configuredEnvironment: this.configuredEnvironment(),
        mismatch: false,
        credentials,
        detail: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
      };
    }
  }

  private async call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; requestId?: string } = { method: 'GET' },
  ): Promise<T> {
    const token = await this.accessToken();

    const response = await fetch(`${this.api}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.requestId ? { 'PayPal-Request-Id': init.requestId } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    if (!response.ok) {
      // The body carries PayPal debug ids and internal field paths, so it goes
      // to the log and never to the browser.
      const detail = await response.text();
      logger.error('paypal.request.failed', {
        path,
        status: response.status,
        detail: detail.slice(0, 500),
      });
      throw AppError.conflict(
        'The payment provider rejected the request. Please try again.',
        'تعذّر إتمام الطلب لدى مزوّد الدفع. حاول مرة أخرى.',
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private baseUrl(): string {
    const env = getEnv();
    return (env.APP_URL ?? env.AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  /* ------------------------------------------------------------------ */
  /*                         Plan provisioning                          */
  /* ------------------------------------------------------------------ */

  /** One cache key per environment so sandbox ids never leak into live. */
  private planSettingKey(planCode: string): string {
    return `paypal.plan.${getEnv().PAYPAL_ENVIRONMENT}.${planCode}`;
  }

  private async ensurePlanId(plan: {
    id: string;
    code: string;
    nameEn: string;
    descriptionEn: string | null;
    priceCents: number;
    currency: string;
    externalPriceId: string | null;
  }): Promise<string> {
    const env = getEnv();

    // An explicitly configured plan id is an operator override and wins. It
    // also opts out of the price-drift check below: PayPal, not this database,
    // then owns the amount charged. Changing the price in the admin panel will
    // not change what subscribers pay until the override is removed.
    if (plan.externalPriceId) return plan.externalPriceId;
    if (plan.code === 'PRO' && env.PAYPAL_PRO_PLAN_ID) {
      logger.warn('paypal.plan.override', {
        planCode: plan.code,
        detail: 'Using PAYPAL_PRO_PLAN_ID; the database price is not authoritative.',
      });
      return env.PAYPAL_PRO_PLAN_ID;
    }

    const cached = await appSettingsRepo.getSetting<{ planId: string; priceCents: number }>(
      this.planSettingKey(plan.code),
    );
    // A price change in the admin panel must not keep charging the old amount.
    if (cached?.planId && cached.priceCents === plan.priceCents) return cached.planId;

    const product = await this.call<{ id: string }>('/v1/catalogs/products', {
      method: 'POST',
      body: {
        name: `${env.PAYPAL_BRAND_NAME} — ${plan.nameEn}`.slice(0, 127),
        description: (plan.descriptionEn ?? 'Academic research assistant subscription').slice(
          0,
          256,
        ),
        type: 'SERVICE',
        category: 'SOFTWARE',
      },
      requestId: `product-${plan.id}-${plan.priceCents}`,
    });

    const created = await this.call<{ id: string }>('/v1/billing/plans', {
      method: 'POST',
      body: {
        product_id: product.id,
        name: `${plan.nameEn} — monthly`,
        description: `${plan.nameEn} subscription, billed monthly`,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: { interval_unit: 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            // 0 means "until cancelled" — the subscription renews indefinitely.
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: toGatewayAmount(plan.priceCents, plan.currency),
                currency_code: plan.currency,
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: 'CANCEL',
          // Three failed attempts, then PayPal suspends — we downgrade on that.
          payment_failure_threshold: 3,
        },
      },
      requestId: `plan-${plan.id}-${plan.priceCents}`,
    });

    await appSettingsRepo.setSetting(this.planSettingKey(plan.code), {
      planId: created.id,
      priceCents: plan.priceCents,
      productId: product.id,
    });

    logger.info('paypal.plan.provisioned', { planCode: plan.code, planId: created.id });
    return created.id;
  }

  /* ------------------------------------------------------------------ */
  /*                              Checkout                              */
  /* ------------------------------------------------------------------ */

  async createCheckout(input: {
    userId: string;
    email: string;
    planCode: string;
    locale: string;
  }): Promise<CheckoutResult> {
    const plan = await plansRepo.findPlanByCode(input.planCode);
    if (!plan?.isActive) throw AppError.notFound('plan');

    if (plan.priceCents <= 0) {
      throw AppError.conflict(
        'Free plans do not go through checkout.',
        'الخطة المجانية لا تمر عبر بوابة الدفع.',
      );
    }

    const planId = await this.ensurePlanId(plan);
    const base = this.baseUrl();

    // Registered here rather than only in the health check: this is the moment
    // it is certainly needed, and a deployment whose operator never opened the
    // health page would otherwise take payments PayPal could not tell us about.
    await this.ensureWebhookId().catch((error: unknown) => {
      logger.error('paypal.webhook.provision_failed', {
        detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
      });
    });

    const subscription = await this.call<SubscriptionResource>('/v1/billing/subscriptions', {
      method: 'POST',
      body: {
        plan_id: planId,
        custom_id: `${input.userId}:${plan.code}`,
        subscriber: { email_address: input.email },
        application_context: {
          brand_name: getEnv().PAYPAL_BRAND_NAME,
          // No `locale`: PayPal negotiates it from the buyer's own account and
          // browser, and an unsupported tag here fails the whole call with a 400.
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          payment_method: {
            payer_selected: 'PAYPAL',
            payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED',
          },
          return_url: `${base}/${input.locale}/billing?checkout=success`,
          cancel_url: `${base}/${input.locale}/billing?checkout=cancelled`,
        },
      },
    });

    const approve = subscription.links?.find((link) => link.rel === 'approve')?.href;
    if (!approve) {
      logger.error('paypal.checkout.no_approve_link', { subscriptionId: subscription.id });
      throw AppError.conflict(
        'PayPal did not return an approval link.',
        'لم يُرجع PayPal رابط الموافقة على الدفع.',
      );
    }

    // Nothing is written to our database here: the plan is granted only when the
    // ACTIVATED webhook arrives, so an abandoned or declined payment cannot
    // leave a user on Pro.
    return { url: approve, applied: false };
  }

  /**
   * Reads a subscription straight from PayPal.
   *
   * This is what makes activation independent of webhook delivery: when the
   * subscriber returns from the approval page, the application asks PayPal what
   * actually happened instead of waiting to be told. Webhooks remain the source
   * of truth for renewals and cancellations, which happen when nobody is
   * looking, but the first activation no longer depends on them.
   */
  async fetchSubscription(subscriptionId: string): Promise<{
    id?: string;
    status?: string;
    userId?: string;
    planCode?: string;
    payerId?: string;
    nextBillingTime?: Date;
  }> {
    const resource = await this.call<SubscriptionResource>(
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );

    const custom = splitCustomId(resource.custom_id);
    return {
      id: resource.id,
      status: resource.status,
      userId: custom.userId,
      planCode: custom.planCode,
      payerId: resource.subscriber?.payer_id,
      nextBillingTime: parseDate(resource.billing_info?.next_billing_time),
    };
  }

  /** PayPal has no hosted customer portal; the app's own billing page is it. */
  async createPortalSession(input: { locale: string }): Promise<{ url: string }> {
    return { url: `/${input.locale}/billing` };
  }

  async cancel(input: { userId: string; atPeriodEnd: boolean }): Promise<void> {
    const existing = await plansRepo.findSubscriptionByUser(input.userId);
    const subscriptionId = existing?.subscription.externalSubscriptionId;
    if (!subscriptionId) throw AppError.notFound('subscription');

    await this.call(`/v1/billing/subscriptions/${subscriptionId}/cancel`, {
      method: 'POST',
      body: {
        reason: input.atPeriodEnd
          ? 'Cancelled by the subscriber at the end of the current period'
          : 'Cancelled by the subscriber',
      },
    });

    // PayPal stops future billing immediately and has no "cancel at period end",
    // so the distinction is kept on our side. Both branches write state now
    // rather than waiting for the CANCELLED webhook: that webhook cannot tell
    // the two intents apart, and guessing from `periodEnd` alone would either
    // extend an immediate cancellation or cut short a paid-for month.
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
      status: 'CANCELED',
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
      periodEnd: null,
      externalSubscriptionId: null,
    });
  }

  /* ------------------------------------------------------------------ */
  /*                              Webhooks                              */
  /* ------------------------------------------------------------------ */

  private webhookSettingKey(): string {
    return `paypal.webhook.${getEnv().PAYPAL_ENVIRONMENT}`;
  }

  /** Where PayPal should deliver events for this deployment. */
  webhookUrl(): string {
    return `${this.baseUrl()}/api/billing/webhook`;
  }

  /**
   * Registers this deployment's webhook with PayPal, once, and remembers its id.
   *
   * Creating the webhook by hand in the dashboard and copying its id into an
   * environment variable is the step most likely to be skipped or mistyped — and
   * when it is, payments succeed while subscriptions silently never activate.
   * Since the application already holds credentials that can create it, it does.
   *
   * `PAYPAL_WEBHOOK_ID` still wins when set, for deployments that share one
   * webhook or register it out of band.
   */
  private async ensureWebhookId(): Promise<string> {
    const configured = (getEnv().PAYPAL_WEBHOOK_ID ?? '').trim();
    if (configured && /^[A-Za-z0-9-]{6,}$/.test(configured)) return configured;

    const url = this.webhookUrl();
    const cached = await appSettingsRepo.getSetting<{ id: string; url: string }>(
      this.webhookSettingKey(),
    );
    if (cached?.id && cached.url === url) return cached.id;

    const existing = await this.call<{ webhooks?: { id: string; url: string }[] }>(
      '/v1/notifications/webhooks',
    );
    let id = existing.webhooks?.find((hook) => hook.url === url)?.id;

    if (!id) {
      const created = await this.call<{ id: string }>('/v1/notifications/webhooks', {
        method: 'POST',
        body: { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) },
      });
      id = created.id;
      logger.info('paypal.webhook.created', { id, url });
    } else {
      logger.info('paypal.webhook.reused', { id, url });
    }

    await appSettingsRepo.setSetting(this.webhookSettingKey(), { id, url });
    return id;
  }


  /**
   * Verified by PayPal itself: the five transmission headers plus the raw body
   * are posted back to `verify-webhook-signature`. Anything other than an
   * explicit SUCCESS is treated as forged.
   */
  private async verify(rawBody: string, headers: Headers): Promise<void> {
    const webhookId = await this.ensureWebhookId();

    const transmissionId = headers.get('paypal-transmission-id');
    const transmissionTime = headers.get('paypal-transmission-time');
    const transmissionSig = headers.get('paypal-transmission-sig');
    const certUrl = headers.get('paypal-cert-url');
    const authAlgo = headers.get('paypal-auth-algo');

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      throw AppError.forbidden();
    }

    // PayPal fetches this certificate itself; a lookalike host would let an
    // attacker present their own signature.
    if (!/^https:\/\/[a-z0-9.-]*\.paypal\.com\//i.test(certUrl)) {
      logger.warn('paypal.webhook.bad_cert_host', { certUrl: certUrl.slice(0, 120) });
      throw AppError.forbidden();
    }

    const result = await this.call<{ verification_status: string }>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: {
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: webhookId,
          webhook_event: JSON.parse(rawBody) as unknown,
        },
      },
    );

    if (result.verification_status !== 'SUCCESS') {
      logger.warn('paypal.webhook.verification_failed', {
        status: result.verification_status,
      });
      throw AppError.forbidden();
    }
  }

  async handleWebhook(rawBody: string, headers: Headers): Promise<BillingEvent> {
    await this.verify(rawBody, headers);

    const event = JSON.parse(rawBody) as {
      id?: string;
      event_type?: string;
      resource?: SubscriptionResource & SaleResource;
    };

    const resource = event.resource ?? {};
    const base = {
      externalEventId: event.id,
      ...splitCustomId(resource.custom_id ?? resource.custom),
    };

    switch (event.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
      case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
      case 'BILLING.SUBSCRIPTION.UPDATED': {
        // PayPal sends UPDATED for edits that are not payments — a suspended
        // subscriber swapping their funding source, for one. Granting on those
        // would hand out a free month, repeatably, from PayPal's own UI. Only
        // the gateway's own ACTIVE status grants anything.
        const active = (resource.status ?? '').toUpperCase() === 'ACTIVE';
        if (!active) {
          return {
            ...base,
            type: 'subscription.updated',
            providerStatus: resource.status,
            externalSubscriptionId: resource.id,
          };
        }

        return {
          ...base,
          type:
            event.event_type === 'BILLING.SUBSCRIPTION.UPDATED'
              ? 'subscription.updated'
              : 'subscription.activated',
          providerStatus: resource.status,
          externalSubscriptionId: resource.id,
          externalCustomerId: resource.subscriber?.payer_id,
          periodEnd: parseDate(resource.billing_info?.next_billing_time),
        };
      }

      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        return {
          ...base,
          type: 'subscription.canceled',
          providerStatus: resource.status,
          externalSubscriptionId: resource.id,
        };

      case 'BILLING.SUBSCRIPTION.SUSPENDED':
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        return {
          ...base,
          type: 'payment.failed',
          providerStatus: resource.status,
          externalSubscriptionId: resource.id,
        };

      case 'PAYMENT.SALE.COMPLETED': {
        const payment = readSale(resource);
        return {
          ...base,
          type: 'payment.succeeded',
          externalSubscriptionId: resource.billing_agreement_id,
          ...(payment ? { payment } : {}),
        };
      }

      case 'PAYMENT.SALE.DENIED':
      case 'PAYMENT.SALE.REVERSED':
        return {
          ...base,
          type: 'payment.failed',
          externalSubscriptionId: resource.billing_agreement_id,
          ...(resource.sale_id ? { relatedPaymentId: resource.sale_id } : {}),
        };

      case 'PAYMENT.SALE.REFUNDED': {
        // A refund payload is a refund object, not a sale: no subscription id
        // and no custom_id. `sale_id` points at the charge being reversed, and
        // that is the only way back to the account.
        const payment = readSale(resource);
        return {
          ...base,
          type: 'payment.refunded',
          externalSubscriptionId: resource.billing_agreement_id,
          ...(resource.sale_id ? { relatedPaymentId: resource.sale_id } : {}),
          ...(payment ? { payment } : {}),
        };
      }

      default:
        return { type: 'ignored', externalEventId: event.id };
    }
  }
}

/** `custom_id` is written as `userId:planCode` when the subscription is created. */
function splitCustomId(value: string | undefined): { userId?: string; planCode?: string } {
  if (!value) return {};
  const separator = value.indexOf(':');
  if (separator === -1) return { userId: value };
  return {
    userId: value.slice(0, separator),
    planCode: value.slice(separator + 1) || undefined,
  };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readSale(resource: SaleResource) {
  const raw = resource.amount?.total ?? resource.amount?.value;
  const currency = resource.amount?.currency ?? resource.amount?.currency_code;
  if (!resource.id || !raw || !currency) return undefined;

  const amount = Number(raw);
  if (!Number.isFinite(amount)) return undefined;

  return {
    externalPaymentId: resource.id,
    amountCents: toMinorUnits(amount, currency),
    currency,
    occurredAt: parseDate(resource.create_time) ?? new Date(),
  };
}
