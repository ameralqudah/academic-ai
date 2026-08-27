import { and, eq, lt } from 'drizzle-orm';

import { db } from '@/server/db';
import { verificationTokens } from '@/server/db/schema';

/**
 * Single-use tokens (password reset today, email verification later) reuse the
 * Auth.js `verification_tokens` table. Only the SHA-256 hash is stored, so a
 * database leak does not hand over working reset links.
 */

export async function put(identifier: string, tokenHash: string, expires: Date): Promise<void> {
  // One live token per identifier: issuing a new link invalidates the old one.
  await db.delete(verificationTokens).where(eq(verificationTokens.identifier, identifier));
  await db.insert(verificationTokens).values({ identifier, token: tokenHash, expires });
}

export async function take(identifier: string, tokenHash: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, identifier),
        eq(verificationTokens.token, tokenHash),
      ),
    )
    .limit(1);

  if (!row) return false;

  // Consumed whether or not it had expired — a used link never works twice.
  await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, identifier),
        eq(verificationTokens.token, tokenHash),
      ),
    );

  return row.expires.getTime() > Date.now();
}

export async function purgeExpired(): Promise<void> {
  await db.delete(verificationTokens).where(lt(verificationTokens.expires, new Date()));
}
