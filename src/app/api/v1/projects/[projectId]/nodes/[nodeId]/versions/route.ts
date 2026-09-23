import { graphAccess } from '@/server/graph/access';
import { listVersions } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string; nodeId: string };

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  await graphAccess(params.projectId, user.id, 'VIEWER');
  return ok(await listVersions(params.projectId, params.nodeId));
});
