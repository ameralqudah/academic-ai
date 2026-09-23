import { ok, withApi } from '@/server/http/api';
import { requestEmailVerification } from '@/server/services/account.service';

/** Sends a fresh confirmation link to the signed-in user. */
export const POST = withApi(
  { rateLimit: { key: 'verify-email-resend', max: 3, windowSeconds: 900 } },
  async ({ user }) => {
    const result = await requestEmailVerification(user.id, user.locale);
    return ok({ sent: !result.alreadyVerified, alreadyVerified: Boolean(result.alreadyVerified) });
  },
);
