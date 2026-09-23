/**
 * Whether a signed session may continue, re-checked against the database.
 *
 * Sessions are JWTs, which the server cannot recall once issued. Left alone, a
 * suspended user, a demoted admin or someone whose password was just reset
 * would keep their access until the token expired — thirty days. Every session
 * is therefore re-validated against the user's row at most once a minute:
 * status, role, verification and a token version that is incremented to end
 * all sessions at once.
 *
 * The decision is a pure function so the security rule can be tested without
 * a request or a database; the lookup and its short cache sit beside it.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/server/db';
import { users } from '@/server/db/schema';

/** How long a token is trusted before the user's row is read again. */
export const REVALIDATE_MS = 60_000;

/** How long one read of a user's row is shared between requests in this process. */
const CACHE_MS = 30_000;

export interface TokenState {
  sub?: string;
  /** The token version the session was issued under. Absent on older sessions, read as 0. */
  tv?: number;
  /** When the session was last checked against the database, in ms. */
  checkedAt?: number;
}

export interface FreshUser {
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED';
  locale: 'ar' | 'en';
  emailVerified: Date | null;
  tokenVersion: number;
}

export type TokenDecision =
  | { action: 'keep' }
  | { action: 'refresh'; patch: { role: FreshUser['role']; locale: FreshUser['locale']; ev: boolean; checkedAt: number } }
  | { action: 'revoke'; reason: 'missing' | 'suspended' | 'version' };

/** Whether the token is due for a check. Kept separate so no read happens when it is not. */
export function needsCheck(token: TokenState, now: number, force = false): boolean {
  return force || typeof token.checkedAt !== 'number' || now - token.checkedAt >= REVALIDATE_MS;
}

export function evaluateToken(token: TokenState, fresh: FreshUser | null | undefined, now: number): TokenDecision {
  if (!fresh) return { action: 'revoke', reason: 'missing' };
  if (fresh.status === 'SUSPENDED') return { action: 'revoke', reason: 'suspended' };
  if ((token.tv ?? 0) !== fresh.tokenVersion) return { action: 'revoke', reason: 'version' };

  return {
    action: 'refresh',
    patch: { role: fresh.role, locale: fresh.locale, ev: Boolean(fresh.emailVerified), checkedAt: now },
  };
}

const cache = new Map<string, { row: FreshUser | null; at: number }>();

/** The fields a session depends on, read at most once per half minute per user in this process. */
export async function loadSessionUser(userId: string, now = Date.now()): Promise<FreshUser | null> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < CACHE_MS) return hit.row;

  const [row] = await db
    .select({
      role: users.role,
      status: users.status,
      locale: users.locale,
      emailVerified: users.emailVerified,
      tokenVersion: users.tokenVersion,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const value = row ?? null;
  cache.set(userId, { row: value, at: now });
  return value;
}

/**
 * Forgets a user's cached row, so a change made by this process is seen on the
 * next request here. Other instances see it within the cache window.
 */
export function forgetSessionUser(userId: string): void {
  cache.delete(userId);
}
