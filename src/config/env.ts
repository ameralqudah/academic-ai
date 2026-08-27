/**
 * Environment validation. Imported only from server code.
 *
 * Fails loudly at boot rather than at the first request, and keeps every secret
 * in one auditable list. Nothing here is ever imported from a client component.
 */

import { z } from 'zod';

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  AUTH_URL: z.string().optional(),
  /**
   * The owner account, by email. It is treated as an administrator and given
   * the top plan without going through checkout. Comma-separated for more than
   * one. Leave empty to disable the override entirely.
   */
  OWNER_EMAIL: z.string().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),

  // AI — provider is swappable without touching application code.
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'google']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  GOOGLE_AI_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().default('gemini-2.5-pro'),

  // Billing — no real keys in code, ever.
  BILLING_PROVIDER: z.enum(['manual', 'stripe', 'paypal']).default('manual'),
  /**
   * Manual billing grants paid plans without taking payment. Allowed freely in
   * development; in production it must be opted into explicitly, otherwise a
   * missing Stripe key would silently turn Pro into a free self-serve upgrade.
   */
  MANUAL_BILLING_ALLOW_PAID: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((value) => value === 'true'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),

  /**
   * PayPal. `live` bills real cards; `sandbox` runs the identical flow against
   * PayPal's test environment so the whole subscription lifecycle can be proven
   * before any money moves.
   */
  /**
   * Tolerant on purpose. A stray space or a pasted `"sandbox"` used to fail
   * validation, and because every server module reads this config at import
   * time, one bad character took the entire application down at boot. An
   * unrecognised value now falls back to `live` and is visible in /api/health.
   */
  PAYPAL_ENVIRONMENT: z
    .preprocess(
      (value) =>
        typeof value === 'string'
          ? value.trim().toLowerCase().replace(/^["']|["']$/g, '')
          : value,
      z.enum(['sandbox', 'live']).catch('live'),
    )
    .default('live'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  /** Required to verify webhooks. Without it every webhook is rejected. */
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  /** Optional: reuse an existing PayPal plan instead of provisioning one. */
  PAYPAL_PRO_PLAN_ID: z.string().optional(),
  /** Shown on PayPal's approval screen. */
  PAYPAL_BRAND_NAME: z.string().default('Academic AI'),

  // Email — console prints the message to the log so password reset works in dev.
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  /** Public origin used to build links in emails. Falls back to AUTH_URL. */
  APP_URL: z.string().optional(),

  // Rate limiting — memory is per-instance; redis is shared across instances.
  RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
  /**
   * Attempts per IP per 15 minutes on sign-up and password-reset.
   *
   * Deliberately configurable: this product's users sit in university labs and
   * campus networks that share one public address, where a hard 5-per-IP limit
   * blocks a whole class. Raise it for such deployments; keep it low for a
   * public sign-up form on the open internet.
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  // On Vercel the public origin is only known after the deployment exists, so it
  // is derived from the platform's own variables unless explicitly configured.
  const platformUrl =
    process.env.RENDER_EXTERNAL_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL}`
      : undefined);
  const source: Record<string, string | undefined> = { ...process.env };
  if (platformUrl) {
    source.APP_URL ??= platformUrl;
    source.AUTH_URL ??= platformUrl;
  }

  const parsed = serverSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/**
 * Test seam. The parsed environment is cached for the life of the process, so a
 * test that changes a variable has to invalidate it. Never called at runtime.
 */
export function resetEnvCache(): void {
  cached = null;
}

/** Public, build-time constants that are safe to reach from the browser. */
export const publicConfig = {
  appName: 'Academic AI Research Assistant',
  supportEmail: 'support@academic-ai.app',
  defaultLocale: 'ar' as const,
};
