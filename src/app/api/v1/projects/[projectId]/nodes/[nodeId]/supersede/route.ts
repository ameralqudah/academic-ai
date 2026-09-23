import { z } from 'zod';

import { graphAccess } from '@/server/graph/access';
import { supersede } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const schema = z.object({
  replacementId: z.string().min(1).max(64),
  impactAcknowledged: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

type Params = { projectId: string; nodeId: string };

export const POST = withApi<z.infer<typeof schema>, Params>({ schema }, async ({ user, params, body }) => {
  await graphAccess(params.projectId, user.id, 'EDITOR');
  const report = await supersede(
    params.projectId,
    params.nodeId,
    body.replacementId,
    { userId: user.id },
    body.impactAcknowledged,
  );
  return ok(report);
});
