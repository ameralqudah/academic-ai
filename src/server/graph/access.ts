/**
 * HTTP gate for the graph API.
 *
 * - The feature flag comes first: with `FF_GRAPH` off, every graph route
 *   answers 404 before authentication, exactly as if it did not exist.
 * - Project roles are checked by the graph service itself (it is the gate for
 *   every caller, not only routes).
 * - Rate limits: writes are bounded per client, reads more loosely.
 */

import { NextResponse } from 'next/server';

import { getEnv } from '@/config/env';

export function graphEnabled(): boolean {
  return getEnv().FF_GRAPH;
}

export const GRAPH_READ_LIMIT = { key: 'graph-read', max: 600, windowSeconds: 60 };
export const GRAPH_WRITE_LIMIT = { key: 'graph-write', max: 120, windowSeconds: 60 };

type Handler<A extends unknown[]> = (request: Request, ...rest: A) => Promise<Response>;

/** Research runs (P1-D): need the graph as well as their own flag. */
export function runsFlagEnabled(): boolean {
  return getEnv().FF_GRAPH && getEnv().FF_RUNS;
}

/**
 * Wraps a route handler so it does not exist while its flag is off:
 * `graph` (FF_GRAPH, the default) or `runs` (FF_GRAPH and FF_RUNS).
 */
export function flagged<A extends unknown[]>(handler: Handler<A>, feature: 'graph' | 'runs' = 'graph'): Handler<A> {
  return async (request, ...rest) => {
    if (feature === 'runs' ? !runsFlagEnabled() : !graphEnabled()) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: 'NOT_FOUND', message: 'The resource was not found.', messageAr: 'العنصر المطلوب غير موجود.' },
        },
        { status: 404 },
      );
    }
    return handler(request, ...rest);
  };
}
