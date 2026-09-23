import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_READ_LIMIT } from '@/server/stats/http';
import { getProvenance } from '@/server/stats/runs';

type Params = { projectId: string; runId: string };

/** Where every number of this run came from. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => ok(await getProvenance({ userId: user.id }, params.runId, params.projectId))),
);
