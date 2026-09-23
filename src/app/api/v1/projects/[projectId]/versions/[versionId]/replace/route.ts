import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { replaceVersion } from '@/server/stats/graph';
import { STATS_BODY_BYTES, STATS_WRITE_LIMIT } from '@/server/stats/http';

const schema = z.object({ newVersionId: z.string().min(1).max(64), impactAcknowledged: z.string().max(128).optional() }).strict();
type Params = { projectId: string; versionId: string };

/**
 * Declares that a newer version replaces this one: every run on this version,
 * and what reports it, becomes not current. Answers 428 with the Impact Report
 * until its hash is acknowledged.
 */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>({ schema, rateLimit: STATS_WRITE_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) =>
    ok(await replaceVersion({ userId: user.id }, params.projectId, params.versionId, body.newVersionId, body.impactAcknowledged)),
  ),
);
