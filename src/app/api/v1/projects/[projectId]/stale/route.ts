import { graphAccess } from '@/server/graph/access';
import { listStale } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string };

export const GET = withApi<undefined, Params>({}, async ({ request, user, params }) => {
  await graphAccess(params.projectId, user.id, 'VIEWER');
  const includeResolved = new URL(request.url).searchParams.get('includeResolved') === 'true';
  return ok(await listStale(params.projectId, { includeResolved }));
});
