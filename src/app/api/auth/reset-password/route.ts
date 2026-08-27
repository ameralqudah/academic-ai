import { ok, withApi } from '@/server/http/api';
import { resetPassword } from '@/server/services/account.service';
import { resetPasswordSchema, type ResetPasswordInput } from '@/server/validation/auth';

export const POST = withApi<ResetPasswordInput>(
  {
    schema: resetPasswordSchema,
    auth: false,
    rateLimit: { key: 'reset-password', max: 10, windowSeconds: 900 },
  },
  async ({ body }) => {
    await resetPassword({ userId: body.uid, token: body.token, password: body.password });
    return ok({ reset: true });
  },
);
