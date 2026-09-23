/**
 * Timeouts and the retry budget (P1-B §2.4). Deterministic: the clock, sleep
 * and jitter are injectable so tests can assert exact behaviour.
 */

import type { RequestKind } from './contract';
import { isRetryable, type GatewayError } from './errors';

/** Hard ceilings. A caller may ask for less, never more. */
export const TIMEOUTS: Record<RequestKind | 'longForm', number> = {
  generate: 120_000,
  structured: 60_000,
  tools: 90_000,
  stream: 180_000,
  embed: 30_000,
  longForm: 240_000,
};

/** A stream must produce its first event, and every next one, within this. */
export const STREAM_IDLE_MS = 30_000;

/** At most this many provider attempts per logical call, retries and failover included. */
export const MAX_ATTEMPTS = 3;

/** Backoff before attempt n (1-based, n ≥ 2), before jitter. */
const BACKOFF_MS = [0, 0, 500, 1500];

/** Never wait longer than this for a provider's `retry-after`. */
export const MAX_RETRY_AFTER_MS = 10_000;

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** In [0, 1). */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
  random: () => Math.random(),
};

export function timeoutFor(kind: RequestKind | 'longForm', requested?: number): number {
  const ceiling = TIMEOUTS[kind];
  return requested ? Math.min(requested, ceiling) : ceiling;
}

/**
 * Delay before `attempt` (2 or 3), honouring the provider's retry-after within
 * the cap; ±20 % jitter. Moving to a *different* model needs no wait: the one
 * that just reported it is overloaded is the only one worth waiting for.
 */
export function backoffMs(attempt: number, error: GatewayError, clock: Clock, sameTarget = true): number {
  if (!sameTarget) return 0;
  const base = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
  const asked = error.retryAfterSeconds ? Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS) : 0;
  const delay = Math.max(base, asked);
  const jitter = 0.8 + clock.random() * 0.4;
  return Math.round(delay * jitter);
}

/**
 * The attempt plan: primary, then the first permitted fallback (if any), then
 * the primary once more — never more than MAX_ATTEMPTS, and never another
 * attempt after a non-retryable failure.
 */
export function nextTarget<T>(attempt: number, primary: T, fallback: T | undefined): T | undefined {
  if (attempt === 1) return primary;
  if (attempt === 2) return fallback ?? primary;
  if (attempt === 3) return primary;
  return undefined;
}

export function shouldRetry(error: GatewayError, attempt: number): boolean {
  return isRetryable(error.errorClass) && attempt < MAX_ATTEMPTS;
}
