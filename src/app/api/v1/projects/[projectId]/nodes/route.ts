import { z } from 'zod';

import { GRAPH_READ_LIMIT, GRAPH_WRITE_LIMIT, flagged } from '@/server/graph/access';
import { createNode, listNodes } from '@/server/graph/service';
import { NODE_TYPES } from '@/server/graph/types';
import { ok, withApi } from '@/server/http/api';

const createSchema = z.object({
  type: z.enum(NODE_TYPES),
  label: z.string().trim().max(200).nullish(),
  data: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['draft', 'active']).optional(),
});

const listQuery = z.object({
  type: z.enum(NODE_TYPES).optional(),
  status: z.enum(['draft', 'active', 'stale', 'superseded', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

type Params = { projectId: string };

export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_READ_LIMIT }, async ({ request, user, params }) => {
    const query = listQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    return ok(await listNodes(params.projectId, { userId: user.id }, query));
  }),
);

export const POST = flagged(
  withApi<z.infer<typeof createSchema>, Params>(
    { schema: createSchema, rateLimit: GRAPH_WRITE_LIMIT },
    async ({ user, params, body }) => {
      const node = await createNode(params.projectId, { userId: user.id }, body);
      return ok(node, { status: 201 });
    },
  ),
);
