import { z } from 'zod';

import { graphAccess } from '@/server/graph/access';
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

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  await graphAccess(params.projectId, user.id, 'VIEWER');
  return ok(await getNode(params.projectId, params.nodeId));
});

export const PATCH = withApi<z.infer<typeof updateSchema>, Params>(
  { schema: updateSchema },
  async ({ request, user, params, body }) => {
    await graphAccess(params.projectId, user.id, 'EDITOR');
    const header = request.headers.get('if-match')?.replace(/"/g, '').trim();
    const expectedVersion = body.expectedVersion ?? (header && /^\d+$/.test(header) ? Number(header) : undefined);
    if (!expectedVersion) {
      throw AppError.validation({ expectedVersion: 'The version being edited is required (or an If-Match header).' });
    }
    const result = await updateNode(params.projectId, params.nodeId, { userId: user.id }, { ...body, expectedVersion });
    return ok(result);
  },
);
