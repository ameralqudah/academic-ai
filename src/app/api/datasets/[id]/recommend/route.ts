import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { recommend } from '@/server/services/statistics.service';

const recommendSchema = z.object({
  roles: z
    .array(
      z.object({
        column: z.string(),
        role: z.enum(['dependent', 'independent', 'grouping', 'covariate', 'paired']),
      }),
    )
    .min(1)
    .max(30),
});

type Body = z.infer<typeof recommendSchema>;

/**
 * Which tests fit these variables, and why.
 *
 * The answer comes from `recommendTest` — deterministic code with the analysis
 * suite behind it — not from a language model. The distinction matters: the
 * choice between a t-test and Mann–Whitney is fully determined by the number of
 * groups and the measurement scale of the outcome, and a model asked twice can
 * answer differently. A wrong choice here does not produce a slightly-off
 * number, it produces a p-value that does not mean what the thesis says it does.
 *
 * Tests that are not built yet come back marked unavailable rather than being
 * quietly replaced with something that would run.
 */
export const POST = withApi<Body, { id: string }>(
  { schema: recommendSchema },
  async ({ user, params, body }) => {
    const result = await recommend({
      datasetId: params.id,
      userId: user.id,
      roles: body.roles,
    });

    return ok(result);
  },
);
