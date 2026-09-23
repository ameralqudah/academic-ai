import { graphAccess } from '@/server/graph/access';
import { unlink } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

type Params = { projectId: string; edgeId: string };

/** `?impactAcknowledged=<hash>` when removing the link has consequences. */
export const DELETE = withApi<undefined, Params>({}, async ({ request, user, params }) => {
  await graphAccess(params.projectId, user.id, 'EDITOR');
  const ack = new URL(request.url).searchParams.get('impactAcknowledged') ?? undefined;
  return ok(await unlink(params.projectId, params.edgeId, ack));
});
