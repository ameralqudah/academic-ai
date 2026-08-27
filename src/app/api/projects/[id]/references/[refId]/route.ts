import { z } from 'zod';

import { CITATION_STYLES } from '@/config/research';
import { ok, withApi } from '@/server/http/api';
import {
  deleteReference,
  formatReference,
  markVerified,
} from '@/server/services/reference.service';

const patchSchema = z.object({
  action: z.enum(['format', 'verify']),
  style: z.enum(CITATION_STYLES).optional(),
});

type Params = { id: string; refId: string };
type Body = z.infer<typeof patchSchema>;

export const PATCH = withApi<Body, Params>(
  { schema: patchSchema, rateLimit: { key: 'reference-format', max: 40, windowSeconds: 300 } },
  async ({ user, params, body }) => {
    if (body.action === 'verify') {
      const reference = await markVerified(params.id, user.id, params.refId);
      return ok(reference);
    }

    const reference = await formatReference({
      projectId: params.id,
      userId: user.id,
      referenceId: params.refId,
      style: body.style ?? 'APA7',
    });
    return ok(reference);
  },
);

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await deleteReference(params.id, user.id, params.refId);
  return ok({ deleted: true });
});
