import { z } from 'zod';

import { graphAccess } from '@/server/graph/access';
import { previewUpdate } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

/** Dry run (R6): the Impact Report for a proposed payload. Writes nothing. */
const schema = z.object({ data: z.record(z.string(), z.unknown()) });

type Params = { projectId: string; nodeId: string };

export const POST = withApi<z.infer<typeof schema>, Params>({ schema }, async ({ user, params, body }) => {
  await graphAccess(params.projectId, user.id, 'VIEWER');
  return ok(await previewUpdate(params.projectId, params.nodeId, body.data));
});
