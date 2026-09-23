import { z } from 'zod';

import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { RUNS_BODY_BYTES, RUNS_CREATE_USER_LIMIT, RUNS_READ_LIMIT, RUNS_READ_USER_LIMIT, RUNS_WRITE_LIMIT } from '@/server/runs/http';
import { createRun, listRuns } from '@/server/runs/service';

type Params = { projectId: string };

const schema = z
  .object({
    intent: z.string().trim().min(1).max(4000),
    datasetVersionId: z.string().min(1).max(64).optional(),
  })
  .strict();

/** The project's research runs (newest first). */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: RUNS_READ_LIMIT, userRateLimit: RUNS_READ_USER_LIMIT }, async ({ user, params }) =>
    ok({ runs: await listRuns({ userId: user.id }, params.projectId) }),
  ),
  'runs',
);

/** Starts a run from an intent. An `Idempotency-Key` header makes a retried request return the same run. */
export const POST = flagged(
  withApi<z.infer<typeof schema>, Params>(
    { schema, rateLimit: RUNS_WRITE_LIMIT, userRateLimit: RUNS_CREATE_USER_LIMIT, maxBodyBytes: RUNS_BODY_BYTES },
    async ({ user, params, body, request }) => {
      const key = request.headers.get('idempotency-key');
      const { run, created } = await createRun({ userId: user.id }, params.projectId, {
        intent: body.intent,
        datasetVersionId: body.datasetVersionId ?? null,
        idempotencyKey: key && /^[A-Za-z0-9._:-]{8,200}$/.test(key) ? key : null,
      });
      return ok({ run, created }, { status: created ? 202 : 200 });
    },
  ),
  'runs',
);
