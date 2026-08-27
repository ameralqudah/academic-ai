import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { startCheckout } from '@/server/services/billing.service';

const schema = z.object({
  planCode: z.string().trim().min(1).max(32),
  locale: z.enum(['ar', 'en']).default('ar'),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { key: 'billing-checkout', max: 10, windowSeconds: 300 } },
  async ({ user, body }) => {
    const result = await startCheckout({
      userId: user.id,
      planCode: body.planCode,
      locale: body.locale,
    });
    return ok(result);
  },
);
