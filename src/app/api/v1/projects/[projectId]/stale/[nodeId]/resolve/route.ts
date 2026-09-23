import { z } from 'zod';

import { graphAccess } from '@/server/graph/access';
import { resolveStale } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const schema = z.object({ resolution: z.enum(['accepted', 'regenerated', 'dismissed']) });

type Params = { projectId: string; nodeId: string };

export const POST = withApi<z.infer<typeof schema>, Params>({ schema }, async ({ user, params, body }) => {
  await graphAccess(params.projectId, user.id, 'EDITOR');
  return ok(await resolveStale(params.projectId, params.nodeId, { userId: user.id }, body.resolution));
});
