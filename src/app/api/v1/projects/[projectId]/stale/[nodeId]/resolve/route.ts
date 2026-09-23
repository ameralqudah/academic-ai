import { z } from 'zod';

import { GRAPH_WRITE_LIMIT, flagged } from '@/server/graph/access';
import { resolveStale } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

/**
 * `marks` names the open marks being resolved (from the stale list or the
 * node); if the node has any others, the request is refused, so nothing is
 * resolved unseen.
 */
const schema = z.object({
  resolution: z.enum(['accepted', 'regenerated', 'dismissed']),
  marks: z
    .array(
      z.object({
        causeNodeId: z.string().min(1).max(64),
        causeVersion: z.number().int().nonnegative(),
        kind: z.enum(['stale', 'untraced', 'stale_input']),
      }),
    )
    .max(1000),
});

type Params = { projectId: string; nodeId: string };

export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: GRAPH_WRITE_LIMIT }, async ({ user, params, body }) =>
    ok(await resolveStale(params.projectId, { userId: user.id }, params.nodeId, body.resolution, body.marks)),
  ),
);
