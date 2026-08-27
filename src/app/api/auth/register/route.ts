import { getEnv } from '@/config/env';
import { ok, withApi } from '@/server/http/api';
import { register } from '@/server/services/account.service';
import { registerSchema, type RegisterInput } from '@/server/validation/auth';

export const POST = withApi<RegisterInput>(
  {
    schema: registerSchema,
    auth: false,
    rateLimit: { key: 'register', max: getEnv().AUTH_RATE_LIMIT_MAX, windowSeconds: 900 },
  },
  async ({ body }) => {
    const user = await register(body);
    return ok(user, { status: 201 });
  },
);
