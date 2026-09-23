/**
 * HTTP limits for the statistics API (P1-C). The routes live under
 * `/api/v1/projects/:projectId/…`, behind `FF_GRAPH` (`flagged`), with the
 * existing session authentication (`withApi`) and project roles (checked by the
 * services, which every caller goes through).
 */

export const STATS_READ_LIMIT = { key: 'stats-read', max: 600, windowSeconds: 60 };
export const STATS_WRITE_LIMIT = { key: 'stats-write', max: 120, windowSeconds: 60 };
/** Runs cost CPU; analyses that need more go to the job queue. */
export const STATS_RUN_LIMIT = { key: 'stats-run', max: 30, windowSeconds: 60 };
/** Model calls (assistant, explanation), on top of the plan's quota. */
export const STATS_AI_LIMIT = { key: 'stats-ai', max: 20, windowSeconds: 60 };
/** JSON bodies: a specification or a transformation is small. */
export const STATS_BODY_BYTES = 256 * 1024;
