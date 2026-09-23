import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { previewReplacement } from '@/server/stats/graph';
import { STATS_READ_LIMIT } from '@/server/stats/http';

type Params = { projectId: string; runId: string };

/** The Impact Report of replacing this run by a re-run: what would stop being current. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => ok({ report: await previewReplacement({ userId: user.id }, params.runId, params.projectId) })),
);
