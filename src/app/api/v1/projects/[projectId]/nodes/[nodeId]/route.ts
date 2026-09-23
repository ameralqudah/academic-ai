import { z } from 'zod';

import { GRAPH_READ_LIMIT, GRAPH_WRITE_LIMIT, flagged } from '@/server/graph/access';
import { getNode, updateNode } from '@/server/graph/service';
import { ok, withApi } from '@/server/http/api';
import { AppError } from '@/server/http/errors';

/**
 * `expectedVersion` (or an `If-Match: <version>` header) is required: an edit
 * made against an old version is refused rather than silently overwriting.
 */
const updateSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  label: z.string().trim().max(200).nullish(),
  expectedVersion: z.number().int().positive().optional(),
  changeNote: z.string().trim().max(1000).optional(),
  impactAcknowledged: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

type Params = { projectId: string; nodeId: string };

/** The node, its open marks, and whether it can be presented as current (`currency`). */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: GRAPH_READ_LIMIT }, async ({ user, params }) => {
    const node = await getNode(params.projectId, { userId: user.id }, params.nodeId);
    return ok(node, { headers: { ETag: `"${node.currentVersion}"` } });
  }),
);

export const PATCH = flagged(
  withApi<z.infer<typeof updateSchema>, Params>(
    { schema: updateSchema, rateLimit: GRAPH_WRITE_LIMIT },
    async ({ request, user, params, body }) => {
      const header = request.headers.get('if-match')?.replace(/"/g, '').trim();
      const expectedVersion = body.expectedVersion ?? (header && /^\d+$/.test(header) ? Number(header) : undefined);
      if (!expectedVersion) {
        throw AppError.validation({ expectedVersion: 'The version being edited is required (or an If-Match header).' });
      }
      const result = await updateNode(params.projectId, { userId: user.id }, params.nodeId, { ...body, expectedVersion });
      return ok(result);
    },
  ),
);
