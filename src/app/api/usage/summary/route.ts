import { ok, withApi } from '@/server/http/api';
import { getSummary } from '@/server/services/usage.service';

export const GET = withApi({}, async ({ user }) => {
  const summary = await getSummary(user.id);
  return ok(summary);
});
