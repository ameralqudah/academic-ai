/**
 * Fixed-window rate limiting behind a swappable store.
 *
 * `memory` is per-instance: on a multi-instance deployment the effective limit
 * multiplies by the instance count, which is fine for a single container and
 * wrong for anything horizontally scaled. `redis` (Upstash REST) shares one
 * window across every instance.
 *
 * Both stores fail **open**: if Redis is unreachable, requests are allowed and a
 * warning is logged. A rate limiter that takes the product down when its backing
 * store blips is worse than the abuse it prevents.
 */

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowState {
  count: number;
  resetAtMs: number;
}

interface RateLimitStore {
  readonly name: 'memory' | 'redis';
  hit(key: string, windowSeconds: number): Promise<WindowState>;
}

/* ------------------------------- memory ---------------------------------- */

class MemoryStore implements RateLimitStore {
  readonly name = 'memory' as const;
  private readonly windows = new Map<string, WindowState>();
  private lastSweep = Date.now();

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, state] of this.windows) {
      if (state.resetAtMs <= now) this.windows.delete(key);
    }
  }

  async hit(key: string, windowSeconds: number): Promise<WindowState> {
    const now = Date.now();
    this.sweep(now);

    const existing = this.windows.get(key);
    if (!existing || existing.resetAtMs <= now) {
      const fresh = { count: 1, resetAtMs: now + windowSeconds * 1000 };
      this.windows.set(key, fresh);
      return fresh;
    }

    existing.count += 1;
    return existing;
  }
}

/* -------------------------------- redis ---------------------------------- */

class UpstashStore implements RateLimitStore {
  readonly name = 'redis' as const;
  private readonly url: string;
  private readonly token: string;
  private readonly fallback = new MemoryStore();

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async hit(key: string, windowSeconds: number): Promise<WindowState> {
    try {
      const response = await fetch(`${this.url}/pipeline`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        // INCR creates the counter; EXPIRE NX sets the window only on the first
        // hit, so a burst cannot keep pushing the expiry forward.
        body: JSON.stringify([
          ['INCR', key],
          ['EXPIRE', key, String(windowSeconds), 'NX'],
          ['PTTL', key],
        ]),
        cache: 'no-store',
      });

      if (!response.ok) throw new Error(`Upstash responded ${response.status}`);

      const results = (await response.json()) as { result?: number }[];
      const count = Number(results[0]?.result ?? 1);
      const ttlMs = Number(results[2]?.result ?? windowSeconds * 1000);

      return {
        count,
        resetAtMs: Date.now() + (ttlMs > 0 ? ttlMs : windowSeconds * 1000),
      };
    } catch (error) {
      logger.warn('rateLimit.redis.unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallback.hit(key, windowSeconds);
    }
  }
}

/* ------------------------------ selection -------------------------------- */

let store: RateLimitStore | null = null;

function resolveStore(): RateLimitStore {
  if (store) return store;

  const env = getEnv();

  if (env.RATE_LIMIT_STORE === 'redis') {
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      store = new UpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
      return store;
    }
    logger.warn('rateLimit.redis.unconfigured', {
      detail:
        'RATE_LIMIT_STORE=redis but UPSTASH_REDIS_REST_URL / _TOKEN are missing — using per-instance memory.',
    });
  }

  store = new MemoryStore();
  return store;
}

/** Exposed for tests; also clears the cached selection after a config change. */
export function resetRateLimitStore(): void {
  store = null;
}

export function rateLimitStoreName(): string {
  return resolveStore().name;
}

export async function consume(
  key: string,
  maxOverride?: number,
  windowOverride?: number,
): Promise<RateLimitResult> {
  const env = getEnv();
  const max = maxOverride ?? env.RATE_LIMIT_MAX_REQUESTS;
  const windowSeconds = windowOverride ?? env.RATE_LIMIT_WINDOW_SECONDS;

  const state = await resolveStore().hit(key, windowSeconds);

  if (state.count > max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetAtMs - Date.now()) / 1000)),
    };
  }

  return { allowed: true, remaining: max - state.count, retryAfterSeconds: 0 };
}

export function clientKey(request: Request, suffix: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
  return `ratelimit:${suffix}:${ip}`;
}
