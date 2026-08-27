import { ok, withApi } from '@/server/http/api';
import { listPublicPlans } from '@/server/services/subscription.service';

export const GET = withApi({ auth: false }, async () => {
  const plans = await listPublicPlans();
  return ok(plans);
});
