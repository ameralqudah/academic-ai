import { GRAPH_READ_LIMIT, flagged } from '@/server/graph/access';
import { listVersions } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string; nodeId: string };

export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_READ_LIMIT }, async ({ user, params }) =>
    ok(await listVersions(params.projectId, { userId: user.id }, params.nodeId)),
  ),
);
