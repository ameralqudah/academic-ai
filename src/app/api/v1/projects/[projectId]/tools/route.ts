import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { RUNS_READ_LIMIT, RUNS_READ_USER_LIMIT } from '@/server/runs/http';
import { listToolsFor } from '@/server/runs/service';

type Params = { projectId: string };

/** The tools a run may use here for the caller (their role and plan); the planner sees the same list. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: RUNS_READ_LIMIT, userRateLimit: RUNS_READ_USER_LIMIT }, async ({ user, params }) => ok(await listToolsFor({ userId: user.id }, params.projectId))),
  'runs',
);
