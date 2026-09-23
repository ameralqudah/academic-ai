/**
 * Brute-force protection for password sign-in.
 *
 * Auth.js handles the credentials callback itself, outside `withApi`, so its
 * limits never applied: an unlimited number of guesses per account was bounded
 * only by bcrypt's cost. This gate sits in front of it.
 *
 * Only failed attempts count. A campus network puts a whole class behind one
 * address, and counting every sign-in would lock out a lecture hall at nine in
 * the morning; counting failures stops guessing and leaves normal use alone.
 * Two windows: per account (guessing one password) and per address (spraying
 * many accounts). The account key is a hash, so no address sits in the store.
 */

import { createHash } from 'node:crypto';

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';
import { clientIp, isLimited, recordHit } from '@/server/http/rate-limit';

export const LOGIN_WINDOW_SECONDS = 900;

function keysFor(request: Request, email: string): { ip: string; account: string | null } {
  const normalised = email.trim().toLowerCase();
  return {
    ip: `ratelimit:login-fail-ip:${clientIp(request)}`,
    account: normalised
      ? `ratelimit:login-fail-email:${createHash('sha256').update(normalised).digest('hex').slice(0, 32)}`
      : null,
  };
}

export async function loginBlocked(
  request: Request,
  email: string,
): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const env = getEnv();
  const keys = keysFor(request, email);

  const checks = await Promise.all([
    isLimited(keys.ip, env.LOGIN_FAILURES_PER_IP),
    keys.account ? isLimited(keys.account, env.LOGIN_FAILURES_PER_EMAIL) : null,
  ]);

  const refused = checks.filter((check) => check && !check.allowed);
  if (refused.length === 0) return { blocked: false, retryAfterSeconds: 0 };

  return {
    blocked: true,
    retryAfterSeconds: Math.max(...refused.map((check) => check?.retryAfterSeconds ?? 1)),
  };
}

export async function recordLoginFailure(request: Request, email: string): Promise<void> {
  const keys = keysFor(request, email);
  await Promise.all([
    recordHit(keys.ip, LOGIN_WINDOW_SECONDS),
    keys.account ? recordHit(keys.account, LOGIN_WINDOW_SECONDS) : undefined,
  ]);
  logger.info('auth.login.failed', { ip: clientIp(request) });
}

/**
 * Whether Auth.js answered a credentials sign-in with a failure.
 *
 * It answers with a redirect URL — JSON for `signIn()` from the browser, a
 * `Location` header for a plain form post — and a failure carries `error=`.
 */
export async function isFailedSignIn(response: Response): Promise<boolean> {
  const location = response.headers.get('location');
  if (location) return /[?&]error=/.test(location);

  if (response.headers.get('content-type')?.includes('application/json')) {
    const body = (await response.clone().json().catch(() => null)) as { url?: string } | null;
    return typeof body?.url === 'string' && /[?&]error=/.test(body.url);
  }

  return response.status >= 400;
}

/** A refusal in the shape Auth.js's client understands: `signIn()` reads `error` from the URL. */
export function rateLimitedResponse(request: Request, retryAfterSeconds: number): Response {
  const origin = new URL(request.url).origin;
  const target = `${origin}/api/auth/signin?error=RateLimited`;
  const headers = { 'Retry-After': String(retryAfterSeconds) };

  if (request.headers.get('x-auth-return-redirect')) {
    return Response.json({ url: target }, { status: 429, headers });
  }
  return new Response(null, { status: 302, headers: { ...headers, location: `${origin}/ar/login?error=RateLimited` } });
}
