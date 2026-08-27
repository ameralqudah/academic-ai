import { billingProvider } from '@/server/billing';
import { logger } from '@/lib/logger';
import { clientKey, consume } from '@/server/http/rate-limit';
import { applyBillingEvent } from '@/server/services/billing.service';

/** Verification calls the gateway back, so allow more than the default budget. */
export const maxDuration = 30;

/**
 * Deliberately outside `withApi`: the payload must be read as a raw string for
 * signature verification, there is no session, and the gateway's own signature
 * is the authentication.
 *
 * Status codes are chosen for the gateway's retry logic, not for a human:
 *
 * - 200 — verified and applied, or knowingly ignored. Stop retrying.
 * - 503 — verified but not yet attributable to an account. PayPal delivers the
 *   first sale and the activation in no guaranteed order, so this asks for a
 *   redelivery instead of dropping a real payment on the floor.
 * - 400 — could not be trusted. Retrying will not help, but silence is worse.
 */
export async function POST(request: Request): Promise<Response> {
  // Unauthenticated and public: every request costs an outbound verification
  // call to PayPal, so it is capped per source address before any work is done.
  const limit = await consume(clientKey(request, 'billing-webhook'), 240, 60);
  if (!limit.allowed) {
    logger.warn('billing.webhook.rate_limited', {});
    return Response.json(
      { received: false },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const raw = await request.text();

  try {
    const provider = billingProvider();
    const event = await provider.handleWebhook(raw, request.headers);
    const outcome = await applyBillingEvent(event);

    if (outcome === 'unmatched') {
      logger.warn('billing.webhook.retry_requested', { type: event.type });
      return Response.json({ received: false, type: event.type }, { status: 503 });
    }

    logger.info('billing.webhook.applied', { provider: provider.name, type: event.type, outcome });
    return Response.json({ received: true, type: event.type, outcome });
  } catch (error) {
    logger.warn('billing.webhook.rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ received: false }, { status: 400 });
  }
}
