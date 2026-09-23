import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_READ_LIMIT } from '@/server/stats/http';
import { listProjectDatasets } from '@/server/stats/versions';

type Params = { projectId: string };

/** The project's tabular datasets and their versions. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => ok({ datasets: await listProjectDatasets({ userId: user.id }, params.projectId) })),
);
