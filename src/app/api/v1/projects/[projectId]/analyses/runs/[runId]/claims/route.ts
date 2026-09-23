import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_BODY_BYTES, STATS_WRITE_LIMIT } from '@/server/stats/http';
import { insertClaim } from '@/server/stats/manuscript';

const schema = z
  .object({
    keys: z.array(z.string().min(1).max(300)).max(50).default([]),
    text: z.string().max(5000).optional(),
    blockId: z.string().max(64).optional(),
  })
  .strict();
type Params = { projectId: string; runId: string };

/** Inserts verified values into the manuscript as a claim that reports them. Typed numbers are refused. */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: STATS_WRITE_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) =>
    ok(await insertClaim({ userId: user.id }, params.projectId, params.runId, body), { status: 201 }),
  ),
);
