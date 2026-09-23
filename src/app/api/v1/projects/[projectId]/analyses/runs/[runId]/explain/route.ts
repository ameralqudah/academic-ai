import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_AI_LIMIT, STATS_BODY_BYTES } from '@/server/stats/http';
import { explainRun } from '@/server/stats/tools';

const schema = z.object({ locale: z.enum(['en', 'ar']).default('en') }).strict();
type Params = { projectId: string; runId: string };

/** A plain-language explanation; every number in it is rendered from the stored estimates. */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: STATS_AI_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) =>
    ok(await explainRun({ userId: user.id }, params.projectId, params.runId, body.locale)),
  ),
);
