import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_BODY_BYTES, STATS_WRITE_LIMIT } from '@/server/stats/http';
import { createSpec, validateSpecRecord } from '@/server/stats/runs';

const schema = z
  .object({
    datasetVersionId: z.string().min(1).max(64),
    spec: z.record(z.string(), z.unknown()),
    label: z.string().trim().max(200).nullish(),
    hypothesisIds: z.array(z.string().max(64)).max(20).optional(),
    constructIds: z.array(z.string().max(64)).max(50).optional(),
  })
  .strict();
type Params = { projectId: string };

/** Creates an immutable specification and returns it with its validation (nothing is computed yet). */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: STATS_WRITE_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) => {
    const actor = { userId: user.id };
    const spec = await createSpec(actor, { ...body, projectId: params.projectId, origin: 'user' });
    return ok({ spec, validation: await validateSpecRecord(actor, spec.id, params.projectId) }, { status: 201 });
  }),
);
