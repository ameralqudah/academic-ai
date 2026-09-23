import { z } from 'zod';

import { graphAccess } from '@/server/graph/access';
import { trace } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

const query = z.object({
  direction: z.enum(['up', 'down']).default('up'),
  depth: z.coerce.number().int().min(1).max(20).default(8),
});

type Params = { projectId: string; nodeId: string };

export const GET = withApi<undefined, Params>({}, async ({ request, user, params }) => {
  await graphAccess(params.projectId, user.id, 'VIEWER');
  const { direction, depth } = query.parse(Object.fromEntries(new URL(request.url).searchParams));
  return ok(await trace(params.projectId, params.nodeId, direction, depth));
});
