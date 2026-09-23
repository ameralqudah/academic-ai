import { z } from 'zod';

import { GRAPH_WRITE_LIMIT, flagged } from '@/server/graph/access';
import { link } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const schema = z.object({
  srcId: z.string().min(1).max(64),
  rel: z.string().min(1).max(40),
  dstId: z.string().min(1).max(64),
  attrs: z.record(z.string(), z.unknown()).optional(),
  pin: z.boolean().optional(),
  impactAcknowledged: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Refer to a replaced or invalidated object on purpose; the new dependent is marked out of date. */
  allowStaleTarget: z.boolean().optional(),
});

type Params = { projectId: string };

export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: GRAPH_WRITE_LIMIT }, async ({ user, params, body }) => {
    const result = await link(params.projectId, { userId: user.id }, body);
    return ok(result, { status: 201 });
  }),
);
