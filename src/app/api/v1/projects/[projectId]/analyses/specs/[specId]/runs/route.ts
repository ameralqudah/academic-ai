import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_BODY_BYTES, STATS_RUN_LIMIT } from '@/server/stats/http';
import { startRun } from '@/server/stats/runs';

const schema = z
  .object({
    idempotencyKey: z.string().min(1).max(200).optional(),
    supersedesRunId: z.string().max(64).optional(),
    impactAcknowledged: z.string().max(128).optional(),
    execution: z.enum(['auto', 'inline', 'job']).optional(),
  })
  .strict();
type Params = { projectId: string; specId: string };

/** Runs a specification with the deterministic engine (inline when small, as a job otherwise). */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: STATS_RUN_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) =>
    ok(await startRun({ userId: user.id }, params.specId, { ...body, projectId: params.projectId }), { status: 201 }),
  ),
);
