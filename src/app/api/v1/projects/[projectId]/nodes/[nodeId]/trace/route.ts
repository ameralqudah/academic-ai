import { z } from 'zod';

import { GRAPH_READ_LIMIT, flagged } from '@/server/graph/access';
import { trace } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const query = z.object({
  direction: z.enum(['up', 'down']).default('up'),
  depth: z.coerce.number().int().min(1).max(20).default(8),
});

type Params = { projectId: string; nodeId: string };

export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_READ_LIMIT }, async ({ request, user, params }) => {
    const { direction, depth } = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    return ok(await trace(params.projectId, { userId: user.id }, params.nodeId, direction, depth));
  }),
);
