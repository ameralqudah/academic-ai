import { flagged } from '@/server/graph/access';
import { ok, withApi } from '@/server/http/api';
import { STATS_READ_LIMIT, STATS_WRITE_LIMIT } from '@/server/stats/http';
import { cancelRun, getRun } from '@/server/stats/runs';

type Params = { projectId: string; runId: string };

/** A run with its verified estimates, tables and figures. */
export const GET = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_READ_LIMIT }, async ({ user, params }) => {
    const detail = await getRun({ userId: user.id }, params.runId, params.projectId);
    return ok({ ...detail, figures: detail.figures.map(({ svg: _svg, ...figure }) => figure) });
  }),
);

/** Cancels a queued or running run. A finished run is never deleted. */
export const DELETE = flagged(
  withApi<undefined, Params>({ rateLimit: STATS_WRITE_LIMIT }, async ({ user, params }) => ok({ cancelled: await cancelRun({ userId: user.id }, params.runId, params.projectId) })),
);
