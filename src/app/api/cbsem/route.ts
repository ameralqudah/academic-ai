import { z } from 'zod';

import { plsModelSchema } from '@/analysis/inference/pls/schema';
import { ok, withApi } from '@/server/http/api';
import { runCbSem } from '@/server/services/pls.service';

/**
 * Confirmatory factor analysis on a model already specified for PLS.
 *
 * The same schema, so a researcher can run both on one specification — which is
 * the usual practice when a reviewer asks for covariance-based confirmation of
 * a PLS result.
 */
const schema = z.object({
  datasetId: z.string(),
  model: plsModelSchema,
  conversationId: z.string().optional(),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 20, windowSeconds: 300, key: 'cbsem.run' } },
  async ({ user, body }) => {
    const result = await runCbSem({
      datasetId: body.datasetId,
      userId: user.id,
      model: body.model,
      conversationId: body.conversationId ?? null,
    });

    return ok({ analysis: result });
  },
);
