import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_READ_LIMIT } from '@/server/stats/http';
import { qualityReport } from '@/server/stats/versions';

type Params = { projectId: string; versionId: string };

/** A version's declared schema and its data-quality report. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => ok(await qualityReport({ userId: user.id }, params.versionId, params.projectId))),
);
