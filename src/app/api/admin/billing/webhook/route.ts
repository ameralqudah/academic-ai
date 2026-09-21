import { billingProvider } from '@/server/billing';
import { PayPalBillingProvider } from '@/server/billing/paypal';
import { AppError } from '@/server/http/errors';
import { ok, withApi } from '@/server/http/api';

/**
 * Registers the payment webhook again with the credentials now in use.
 *
 * For the operator who changed PayPal apps, or whose webhook was deleted in the
 * dashboard: the deployment keeps the id it registered first, and without this
 * the only way to make it look again was to edit a database row.
 */
export const POST = withApi({ admin: true }, async () => {
  const provider = billingProvider();

  if (!(provider instanceof PayPalBillingProvider)) {
    throw new AppError(
      'VALIDATION',
      'The active payment provider does not use a registered webhook.',
      'مزوّد الدفع الحالي لا يستخدم Webhook مسجّلًا.',
    );
  }

  const id = await provider.reregisterWebhook();
  return ok({ id, status: await provider.webhookStatus() });
});
