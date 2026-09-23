import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { RUNS_READ_LIMIT, RUNS_READ_USER_LIMIT, RUNS_WRITE_LIMIT } from '@/server/runs/http';
import { cancelRun, getRun } from '@/server/runs/service';

type Params = { projectId: string; runId: string };

/** A run with its steps, approvals and events (`?after=<event id>` for new events only). */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: RUNS_READ_LIMIT, userRateLimit: RUNS_READ_USER_LIMIT }, async ({ user, params, request }) => {
    const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
    return ok(await getRun({ userId: user.id }, params.projectId, params.runId, Number.isSafeInteger(after) && after > 0 ? after : 0));
  }),
  'runs',
);

/** Requests cancellation (monotonic: a finished run stays as it is). */
export const DELETE = flagged(
  withApi<undefined, Params>({ rateLimit: RUNS_WRITE_LIMIT }, async ({ user, params }) => ok({ run: await cancelRun({ userId: user.id }, params.projectId, params.runId) })),
  'runs',
);
