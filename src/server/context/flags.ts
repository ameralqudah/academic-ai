/**
 * Context V2 switches (P1-E).
 *
 * `FF_CONTEXT_V2` turns the new context assembler on; its graph-based parts —
 * the project snapshot's graph section and the focus-graph slice — need
 * `FF_GRAPH` as well, so with the graph off the assembler never reads it.
 * Both default to off: the existing product is unchanged until they are set.
 */

import { getEnv } from '@/config/env';

/** Whether the context assembler v2 is on. */
export function contextV2Enabled(): boolean {
  return getEnv().FF_CONTEXT_V2;
}

/** Whether context V2 may use the Research Graph: both flags on. */
export function graphContextEnabled(): boolean {
  const env = getEnv();
  return env.FF_CONTEXT_V2 && env.FF_GRAPH;
}
