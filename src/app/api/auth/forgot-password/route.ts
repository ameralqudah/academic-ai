import { getEnv } from '@/config/env';
import { ok, withApi } from '@/server/http/api';
import { requestPasswordReset } from '@/server/services/account.service';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@/server/validation/auth';

export const POST = withApi<ForgotPasswordInput>(
  {
    schema: forgotPasswordSchema,
    auth: false,
    // Tighter than the global limit: this endpoint sends mail and is the natural
    // target for both enumeration and mailbox flooding.
    rateLimit: { key: 'forgot-password', max: getEnv().AUTH_RATE_LIMIT_MAX, windowSeconds: 900 },
  },
  async ({ body }) => {
    await requestPasswordReset(body.email, body.locale);
    // Always the same response, whether or not the address exists.
    return ok({ sent: true });
  },
);
