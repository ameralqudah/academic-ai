import { GRAPH_READ_LIMIT, flagged } from '@/server/graph/access';
import { listStale } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string };

export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_READ_LIMIT }, async ({ request, user, params }) => {
    const includeResolved = new URL(request.url).searchParams.get('includeResolved') === 'true';
    return ok(await listStale(params.projectId, { userId: user.id }, { includeResolved }));
  }),
);
