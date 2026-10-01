import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { syncRunToGraph } from '@/server/stats/graph';
import { STATS_WRITE_LIMIT } from '@/server/stats/http';

type Params = { projectId: string; runId: string };

/**
 * Records a succeeded run in the Research Graph after the fact (WS3-E, E2), so
 * its values can be cited. Idempotent: a recorded run returns its node.
 */
export const POST = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_WRITE_LIMIT }, async ({ user, params }) =>
    ok({ graphRunNodeId: await syncRunToGraph({ userId: user.id }, params.runId, params.projectId) }),
  ),
);
