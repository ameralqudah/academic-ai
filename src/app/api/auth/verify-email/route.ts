import { ok, withApi } from '@/server/http/api';
import { verifyEmail } from '@/server/services/account.service';
import { verifyEmailSchema, type VerifyEmailInput } from '@/server/validation/auth';

/** Consumes a confirmation link. Public: the link is the proof. */
export const POST = withApi<VerifyEmailInput>(
  {
    schema: verifyEmailSchema,
    auth: false,
    rateLimit: { key: 'verify-email', max: 10, windowSeconds: 900 },
  },
  async ({ body }) => {
    await verifyEmail({ userId: body.uid, token: body.token });
    return ok({ verified: true });
  },
);
