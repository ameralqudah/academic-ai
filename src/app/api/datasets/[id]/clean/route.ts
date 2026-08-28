import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { saveCleanedCopy } from '@/server/services/dataset.service';

const cleanSchema = z.object({
  actions: z
    .array(
      z.object({
        kind: z.string(),
        columns: z.array(z.string()).max(300),
        reasonKey: z.string(),
        reasonParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        recommended: z.boolean(),
        destructive: z.boolean(),
      }),
    )
    .max(200),
});

type Body = z.infer<typeof cleanSchema>;

/**
 * Produces a cleaned copy as a new dataset.
 *
 * The original is never modified — cleaning derives, it does not overwrite —
 * so the researcher's file survives exactly as they uploaded it, mistakes and
 * all. That matters the day a supervisor asks what the raw data looked like.
 */
export const POST = withApi<Body, { id: string }>(
  { schema: cleanSchema, rateLimit: { max: 20, windowSeconds: 300, key: 'datasets.clean' } },
  async ({ user, params, body }) => {
    const result = await saveCleanedCopy({
      datasetId: params.id,
      userId: user.id,
      actions: body.actions as unknown as Parameters<typeof saveCleanedCopy>[0]['actions'],
    });

    return ok(result, { status: 201 });
  },
);
