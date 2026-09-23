import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_BODY_BYTES, STATS_WRITE_LIMIT } from '@/server/stats/http';
import { transformSchema, transformVersion, type TransformInput } from '@/server/stats/versions';

type Params = { projectId: string; versionId: string };

/** A new version by a recorded, deterministic operation (`set-schema` or `clean`). The input version is never changed. */
export const POST = flagged(
  withApi<TransformInput, Params>({ schema: transformSchema, rateLimit: STATS_WRITE_LIMIT, maxBodyBytes: STATS_BODY_BYTES }, async ({ user, params, body }) =>
    ok(await transformVersion({ userId: user.id }, params.versionId, body, params.projectId), { status: 201 }),
  ),
);
