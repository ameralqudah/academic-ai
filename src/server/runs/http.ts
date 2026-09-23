/**
 * HTTP limits for the research-run API (P1-D). Every route is behind
 * `flagged(…, 'runs')`, `withApi` (session), an address limit and a per-user
 * limit (after authentication), and a body cap. Project roles are checked by
 * the service, and the database enforces RLS underneath.
 */

export const RUNS_READ_LIMIT = { key: 'runs-read', max: 600, windowSeconds: 60 };
export const RUNS_WRITE_LIMIT = { key: 'runs-write', max: 60, windowSeconds: 60 };
/** Starting a run costs a planning model call; per user. */
export const RUNS_CREATE_USER_LIMIT = { key: 'runs-create', max: 10, windowSeconds: 600 };
export const RUNS_DECIDE_USER_LIMIT = { key: 'runs-decide', max: 60, windowSeconds: 600 };
export const RUNS_READ_USER_LIMIT = { key: 'runs-read-user', max: 600, windowSeconds: 60 };
export const RUNS_BODY_BYTES = 16 * 1024;
