import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { RUNS_BODY_BYTES, RUNS_DECIDE_USER_LIMIT, RUNS_WRITE_LIMIT } from '@/server/runs/http';
import { decideApproval } from '@/server/runs/service';

type Params = { projectId: string; runId: string; approvalId: string };

/** The decision must echo the exact action hash that was shown; a generic "approved" is not accepted. */
const schema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>(
    { schema, rateLimit: RUNS_WRITE_LIMIT, userRateLimit: RUNS_DECIDE_USER_LIMIT, maxBodyBytes: RUNS_BODY_BYTES },
    async ({ user, params, body }) => ok(await decideApproval({ userId: user.id }, params.projectId, params.runId, params.approvalId, body)),
  ),
  'runs',
);
