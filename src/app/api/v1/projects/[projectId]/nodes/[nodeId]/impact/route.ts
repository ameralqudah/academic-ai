import { z } from 'zod';

import { GRAPH_READ_LIMIT, flagged } from '@/server/graph/access';
import { previewUpdate } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';

/** Dry run (R6): the Impact Report for a proposed payload. Writes nothing. */
const schema = z.object({ data: z.record(z.string(), z.unknown()) });

type Params = { projectId: string; nodeId: string };

export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: GRAPH_READ_LIMIT }, async ({ user, params, body }) =>
    ok(await previewUpdate(params.projectId, { userId: user.id }, params.nodeId, body.data)),
  ),
);
