import { z } from 'zod';

import { graphAccess } from '@/server/graph/access';
import { link } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const schema = z.object({
  srcId: z.string().min(1).max(64),
  rel: z.string().min(1).max(40),
  dstId: z.string().min(1).max(64),
  attrs: z.record(z.string(), z.unknown()).optional(),
  pin: z.boolean().optional(),
  impactAcknowledged: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

type Params = { projectId: string };

export const POST = withApi<z.infer<typeof schema>, Params>({ schema }, async ({ user, params, body }) => {
  await graphAccess(params.projectId, user.id, 'EDITOR');
  const result = await link(params.projectId, { userId: user.id }, body);
  return ok(result, { status: 201 });
});
