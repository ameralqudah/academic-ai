import { z } from 'zod';

import { GRAPH_WRITE_LIMIT, flagged } from '@/server/graph/access';
import { supersede } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const schema = z.object({
  replacementId: z.string().min(1).max(64),
  impactAcknowledged: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

type Params = { projectId: string; nodeId: string };

export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: GRAPH_WRITE_LIMIT }, async ({ user, params, body }) =>
    ok(await supersede(params.projectId, { userId: user.id }, params.nodeId, body.replacementId, body.impactAcknowledged)),
  ),
);
