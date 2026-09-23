/**
 * Quota reservation (P1-B §2.6), on the existing plan limits and the existing
 * ledger (`usage_tracking`). No second quota system: this adds the reservation
 * that the check-then-act `assertCanUseAI` never had.
 *
 * reserve → execute → commit (actual usage) | release (no provider usage)
 *
 * - **Concurrency-safe.** Reserve and commit run under one per-user advisory
 *   transaction lock, and a reservation counts against the plan until it is
 *   settled or expires. N concurrent calls against R remaining requests yield
 *   exactly R reservations.
 * - **Idempotent.** A reservation is keyed by (user, idempotency key); asking
 *   again with the same key returns the same reservation, so a retried job step
 *   does not reserve twice.
 * - **Crash-safe.** An unsettled reservation stops counting at `expires_at`
 *   and is released by the reaper.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { countWords } from '@/lib/text';
import { db } from '@/server/db';
import { aiQuotaReservations, usageTracking } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { periodKeyFor } from '@/server/repositories/usage.repository';

import { GatewayError } from './errors';

export const RESERVATION_TTL_MS = 15 * 60_000;

export interface Reservation {
  id: string;
  userId: string;
  periodKey: string;
  requests: number;
  words: number;
  status: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockUser(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai-quota:${userId}`}))`);
}

/** Committed usage plus open, unexpired reservations, this period. */
async function inUse(tx: Tx, userId: string, periodKey: string) {
  const [ledger] = await tx
    .select({
      requests: sql<number>`coalesce(sum(case when ${usageTracking.metric} = 'AI_REQUEST' then ${usageTracking.amount} else 0 end), 0)::int`,
      words: sql<number>`coalesce(sum(case when ${usageTracking.metric} = 'GENERATED_WORD' then ${usageTracking.amount} else 0 end), 0)::int`,
    })
    .from(usageTracking)
    .where(and(eq(usageTracking.userId, userId), eq(usageTracking.periodKey, periodKey)));
  const [held] = await tx
    .select({
      requests: sql<number>`coalesce(sum(${aiQuotaReservations.requests}), 0)::int`,
      words: sql<number>`coalesce(sum(${aiQuotaReservations.words}), 0)::int`,
    })
    .from(aiQuotaReservations)
    .where(
      and(
        eq(aiQuotaReservations.userId, userId),
        eq(aiQuotaReservations.periodKey, periodKey),
        eq(aiQuotaReservations.status, 'reserved'),
        gt(aiQuotaReservations.expiresAt, sql`now()`),
      ),
    );
  return {
    requests: Number(ledger?.requests ?? 0) + Number(held?.requests ?? 0),
    words: Number(ledger?.words ?? 0) + Number(held?.words ?? 0),
  };
}

export interface ReserveInput {
  userId: string;
  idempotencyKey: string;
  /** 1 for a user-visible generation, 0 for an internal step. */
  requests: number;
  words: number;
  /** A later round of an admitted call: needs no headroom of its own (see below). */
  continuation?: boolean;
  limits: { maxAiRequests: number; maxGeneratedWords: number };
  unlimited: (limit: number) => boolean;
  now?: Date;
}

export async function reserve(input: ReserveInput): Promise<Reservation> {
  const periodKey = periodKeyFor(input.now);
  return db.transaction(async (tx) => {
    await lockUser(tx, input.userId);

    const [existing] = await tx
      .select()
      .from(aiQuotaReservations)
      .where(and(eq(aiQuotaReservations.userId, input.userId), eq(aiQuotaReservations.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (existing && existing.status !== 'released') return existing;

    const used = await inUse(tx, input.userId, periodKey);
    const { maxAiRequests, maxGeneratedWords } = input.limits;
    /*
     * A counted call needs room for itself. An internal step that precedes one
     * (classification, planning) is not counted, but it is refused once nothing
     * is left: otherwise a used-up plan keeps paying for a classification of
     * every message. Only a continuation of an admitted call runs at the limit.
     */
    const needed = input.requests > 0 ? input.requests : input.continuation ? 0 : 1;
    if (needed > 0 && !input.unlimited(maxAiRequests) && used.requests + needed > maxAiRequests) {
      throw new GatewayError('quota', 'The plan’s AI requests for this month are used up.', {}).withCause(
        AppError.planLimit('aiRequests', used.requests, maxAiRequests),
      );
    }
    /*
     * Likewise at least one word of room, whatever was estimated: a zero
     * estimate must not slip past a plan whose words are used up. A
     * continuation is checked only against what it says it will write.
     */
    const wantsWords = !input.continuation || input.words > 0;
    if (wantsWords && !input.unlimited(maxGeneratedWords) && used.words + Math.max(input.words, 1) > maxGeneratedWords) {
      throw new GatewayError('quota', 'The plan’s generated words for this month are used up.', {}).withCause(
        AppError.planLimit('generatedWords', used.words, maxGeneratedWords),
      );
    }

    const expiresAt = new Date((input.now ?? new Date()).getTime() + RESERVATION_TTL_MS);
    if (existing) {
      const [revived] = await tx
        .update(aiQuotaReservations)
        .set({ status: 'reserved', requests: input.requests, words: input.words, expiresAt, settledAt: null, periodKey })
        .where(eq(aiQuotaReservations.id, existing.id))
        .returning();
      return revived!;
    }
    const [created] = await tx
      .insert(aiQuotaReservations)
      .values({ userId: input.userId, periodKey, idempotencyKey: input.idempotencyKey, requests: input.requests, words: input.words, expiresAt })
      .returning();
    return created!;
  });
}

export interface CommitInput {
  reservation: Reservation;
  countsAsRequest: boolean;
  outputText: string;
  projectId: string | null;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
}

/**
 * Writes the actual usage to the ledger and settles the reservation, in one
 * transaction under the same lock, so no reader ever sees both or neither.
 * Committing an already-settled reservation is a no-op (idempotent).
 */
export async function commit(input: CommitInput): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUser(tx, input.reservation.userId);
    const [current] = await tx.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.id, input.reservation.id)).for('update');
    if (!current || current.status === 'committed') return;

    const base = {
      userId: current.userId,
      projectId: input.projectId,
      periodKey: current.periodKey,
      provider: input.provider,
      model: input.model,
    };
    await tx.insert(usageTracking).values({
      ...base,
      metric: 'AI_REQUEST',
      amount: input.countsAsRequest ? 1 : 0,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costMicroUsd: input.costMicroUsd,
    });
    const words = countWords(input.outputText);
    if (words > 0) await tx.insert(usageTracking).values({ ...base, metric: 'GENERATED_WORD', amount: words });

    await tx.update(aiQuotaReservations).set({ status: 'committed', settledAt: new Date() }).where(eq(aiQuotaReservations.id, current.id));
  });
}

/** Releases a reservation that consumed nothing (the provider was never reached, or refused before any usage). */
export async function release(reservation: Reservation): Promise<void> {
  await db
    .update(aiQuotaReservations)
    .set({ status: 'released', settledAt: new Date() })
    .where(and(eq(aiQuotaReservations.id, reservation.id), eq(aiQuotaReservations.status, 'reserved')));
}

/** Reaper: reservations whose worker died stop counting at expiry; this settles them. */
export async function releaseExpired(): Promise<number> {
  const rows = await db
    .update(aiQuotaReservations)
    .set({ status: 'released', settledAt: new Date() })
    .where(and(eq(aiQuotaReservations.status, 'reserved'), lt(aiQuotaReservations.expiresAt, sql`now()`)))
    .returning({ id: aiQuotaReservations.id });
  return rows.length;
}
