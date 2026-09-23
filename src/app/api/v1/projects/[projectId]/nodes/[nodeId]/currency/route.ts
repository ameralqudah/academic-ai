import { GRAPH_READ_LIMIT, flagged } from '@/server/graph/access';
import { assess } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string; nodeId: string };

/**
 * Whether the object can be presented as current (`effective`), and what the
 * numbers it shows are worth (`verification`: verified, provisional, manual,
 * not_current, untraced or none), with the upstream objects responsible.
 */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_READ_LIMIT }, async ({ user, params }) =>
    ok(await assess(params.projectId, { userId: user.id }, params.nodeId)),
  ),
);
