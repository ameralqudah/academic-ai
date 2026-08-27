import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { cancelSubscription } from '@/server/services/billing.service';

const schema = z.object({ atPeriodEnd: z.boolean().default(true) });
type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { key: 'billing-cancel', max: 10, windowSeconds: 300 } },
  async ({ user, body }) => {
    await cancelSubscription(user.id, body.atPeriodEnd);
    return ok({ canceled: true });
  },
);
