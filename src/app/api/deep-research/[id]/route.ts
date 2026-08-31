import { ok, withApi } from '@/server/http/api';
import { cancelResearch, getResearchJob } from '@/server/services/deep-research.service';

type Params = { id: string };

/**
 * Progress, and the report once it is ready.
 *
 * Polled rather than streamed: the workflow reports a stage change every few
 * seconds over several minutes, and holding a connection open for that is more
 * machinery than the information justifies — a request every two seconds says
 * the same thing and survives a dropped connection.
 */
export const GET = withApi<undefined, Params>(
  { rateLimit: { max: 300, windowSeconds: 300, key: 'research.poll' } },
  async ({ user, params }) => ok(await getResearchJob(params.id, user.id)),
);

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await cancelResearch(params.id, user.id);
  return ok({ cancelled: true });
});
