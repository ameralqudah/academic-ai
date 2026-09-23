import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_READ_LIMIT } from '@/server/stats/http';
import { listVersions } from '@/server/stats/versions';

type Params = { projectId: string; datasetId: string };

/** Every version of a dataset (version 1 is created on first use), with the transformations between them. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => ok(await listVersions({ userId: user.id }, params.datasetId, params.projectId))),
);
