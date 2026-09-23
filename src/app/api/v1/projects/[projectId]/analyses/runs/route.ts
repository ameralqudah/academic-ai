import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_READ_LIMIT } from '@/server/stats/http';
import { listRuns } from '@/server/stats/runs';

type Params = { projectId: string };

export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => ok({ runs: await listRuns({ userId: user.id }, params.projectId) })),
);
