import { sql } from 'drizzle-orm';

import { getEnv } from '@/config/env';
import { resolveProvider } from '@/ai/registry';
import { describeKeyProblem } from '@/ai/key';
import { billingProvider } from '@/server/billing';
import { PayPalBillingProvider } from '@/server/billing/paypal';
import { db } from '@/server/db';
import { emailProvider } from '@/server/email';
import * as plansRepo from '@/server/repositories/plans.repository';
import { rateLimitStoreName } from '@/server/http/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Post-deploy smoke check. Reports whether each dependency is actually wired,
 * never what it is wired with — no key, URL, or connection string is exposed.
 *
 *   curl https://<your-app>/api/health
 */
/** Which env var backs the active provider, for the health report only. */
function apiKeyFor(env: ReturnType<typeof getEnv>, provider: string): string | undefined {
  if (provider === 'openai') return env.OPENAI_API_KEY;
  if (provider === 'google') return env.GOOGLE_AI_API_KEY;
  return env.ANTHROPIC_API_KEY;
}

export async function GET(): Promise<Response> {
  const checks: Record<string, unknown> = {};
  let healthy = true;
  const problems: string[] = [];

  // Database + migrations + seed, in one round trip.
  try {
    const [row] = await db.execute<{ tables: number }>(
      sql`select count(*)::int as tables from information_schema.tables where table_schema = 'public'`,
    );
    const plans = await plansRepo.listActivePlans();
    const hasDefault = plans.some((plan) => plan.isDefault);

    checks.database = {
      connected: true,
      tables: Number(row?.tables ?? 0),
      plansSeeded: plans.length,
      defaultPlan: hasDefault,
    };
    if (!hasDefault) healthy = false;
  } catch (error) {
    healthy = false;
    checks.database = {
      connected: false,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    };
  }

  try {
    const env = getEnv();
    checks.auth = { secretConfigured: env.AUTH_SECRET.length >= 16, googleEnabled: Boolean(env.AUTH_GOOGLE_ID) };

    const ai = await resolveProvider();
    const aiKeyProblem = describeKeyProblem(apiKeyFor(env, ai.name));
    checks.ai = {
      provider: ai.name,
      model: ai.model,
      configured: ai.isConfigured(),
      ...(ai.isConfigured() ? {} : { detail: aiKeyProblem ?? 'No API key is set.' }),
    };
    if (!ai.isConfigured()) {
      healthy = false;
      problems.push(
        `AI (${ai.name}): ${aiKeyProblem ?? 'no API key is set'} — AI features will not work.`,
      );
    }

    const mail = emailProvider();
    checks.email = { provider: mail.name, deliversRealEmail: mail.name !== 'console' };
    if (env.NODE_ENV === 'production' && mail.name === 'console') {
      healthy = false;
      problems.push('Email: no real provider configured — password resets will not be delivered.');
    }

    const billing = billingProvider();
    checks.billing = {
      provider: billing.name,
      configured: billing.isConfigured(),
      takesRealPayments: billing.takesRealPayments,
    };

    // Whether the gateway *accepts* the credentials, not merely whether they are
    // present. A rejected key looks identical to a working one from the outside,
    // and the only symptom is that checkout silently fails for every customer.
    // Reported rather than folded into `healthy`: the rest of the product works,
    // and this response has to stay readable while the operator fixes it.
    if (billing instanceof PayPalBillingProvider) {
      const gateway = await billing.diagnose();
      checks.billing = {
        provider: billing.name,
        configured: billing.isConfigured(),
        takesRealPayments: billing.takesRealPayments,
        gateway,
      };
      if (!gateway.authenticated) {
        problems.push(`Payments: PayPal rejected the credentials — ${gateway.detail ?? 'see logs'}`);
      } else if (gateway.mismatch) {
        problems.push(
          'Payments: PAYPAL_ENVIRONMENT is "live" but these credentials belong to the sandbox. ' +
            'No real money can be taken. Copy the Client ID and Secret from the Live tab of ' +
            'PayPal Apps & Credentials.',
        );
      } else if (gateway.webhook && !gateway.webhook.id) {
        problems.push(
          `Payments: the webhook could not be registered — ${gateway.webhook.detail ?? 'see logs'}`,
        );
      }
    }
    checks.rateLimit = { store: rateLimitStoreName() };
    checks.environment = env.NODE_ENV;
  } catch (error) {
    healthy = false;
    checks.config = {
      valid: false,
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    };
  }

  // 503 is reserved for "this deployment cannot serve": the database is gone.
  // A missing AI key degrades one feature — the site still works, and answering
  // 503 there only hides this very report from the operator trying to read it.
  const database = checks.database as { connected?: boolean } | undefined;
  const serving = database?.connected === true;

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      problems,
      checks,
      checkedAt: new Date().toISOString(),
    },
    { status: serving ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
