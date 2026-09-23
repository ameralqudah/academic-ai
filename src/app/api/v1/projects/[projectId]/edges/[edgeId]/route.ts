import { GRAPH_WRITE_LIMIT, flagged } from '@/server/graph/access';
import { unlink } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string; edgeId: string };

/** `?impactAcknowledged=<hash>` when removing the link has consequences. */
export const DELETE = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_WRITE_LIMIT }, async ({ request, user, params }) => {
    const ack = new URL(request.url).searchParams.get('impactAcknowledged') ?? undefined;
    return ok(await unlink(params.projectId, { userId: user.id }, params.edgeId, ack));
  }),
);
