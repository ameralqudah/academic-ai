import { ok, withApi } from '@/server/http/api';
import { cancelJob, getJob } from '@/server/services/pls.service';

type Params = { id: string };

/**
 * Progress and, once it is ready, the result.
 *
 * Polled rather than streamed. A bootstrap reports a whole number a hundred
 * times over a minute, and holding a connection open for that is more machinery
 * than the information justifies — a request every second or two says the same
 * thing and survives a lost connection.
 *
 * The rate limit is generous because polling is the intended use.
 */
export const GET = withApi<undefined, Params>(
  { rateLimit: { max: 300, windowSeconds: 300, key: 'pls.job.poll' } },
  async ({ user, params }) => {
    return ok(await getJob(params.id, user.id));
  },
);

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await cancelJob(params.id, user.id);
  return ok({ cancelled: true });
});
