import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { openPortal } from '@/server/services/billing.service';

const schema = z.object({ locale: z.enum(['ar', 'en']).default('ar') });
type Body = z.infer<typeof schema>;

export const POST = withApi<Body>({ schema }, async ({ user, body }) => {
  const result = await openPortal(user.id, body.locale);
  return ok(result);
});
