import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_AI_LIMIT, STATS_BODY_BYTES } from '@/server/stats/http';
import { runAssistant } from '@/server/stats/tools';

const schema = z.object({ datasetVersionId: z.string().min(1).max(64), request: z.string().trim().min(1).max(4000) }).strict();
type Params = { projectId: string };

/** The analysis assistant: proposes and runs specifications through the engine's tools; never writes a number. */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: STATS_AI_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) =>
    ok(await runAssistant({ userId: user.id }, params.projectId, body.datasetVersionId, body.request)),
  ),
);
