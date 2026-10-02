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
 *   and is settled by the reaper: committed from the call's durable usage
 *   rows when the provider was reached, released when it was not (WS4 G2).
 * - **Completed work is not redone for free (WS4 G8).** A key whose
 *   reservation is already committed names finished work: asking again is
 *   refused before any provider is contacted, rather than sharing the settled
 *   reservation (whose commit would then be a no-op, leaving the new call
 *   unbilled). A key still `reserved` is a retry of unfinished work and shares
 *   it, as before; a `released` key consumed nothing and is reserved afresh.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';

import { countWords } from '@/lib/text';
import { db } from '@/server/db';
import { aiQuotaReservations, aiUsageEvents, usageTracking } from '@/server/db/schema';
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
    if (existing?.status === 'committed') {
      throw new GatewayError('invalid_request', 'This idempotency key belongs to a call that has already completed and been charged; the call is refused.', {
        detail: 'idempotency_key_committed',
      });
    }
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
  /** Generated words, when the text itself is not at hand (reaper recovery); otherwise counted from `outputText`. */
  words?: number;
}

/**
 * Writes the actual usage to the ledger and settles the reservation, in one
 * transaction under the same lock, so no reader ever sees both or neither.
 * Committing an already-settled reservation is a no-op (idempotent); the
 * result says whether this call wrote the ledger.
 */
export async function commit(input: CommitInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockUser(tx, input.reservation.userId);
    const [current] = await tx.select().from(aiQuotaReservations).where(eq(aiQuotaReservations.id, input.reservation.id)).for('update');
    if (!current || current.status === 'committed') return false;

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
    const words = input.words ?? countWords(input.outputText);
    if (words > 0) await tx.insert(usageTracking).values({ ...base, metric: 'GENERATED_WORD', amount: words });

    await tx.update(aiQuotaReservations).set({ status: 'committed', settledAt: new Date() }).where(eq(aiQuotaReservations.id, current.id));
    return true;
  });
}

/** Releases a reservation that consumed nothing (the provider was never reached, or refused before any usage). */
export async function release(reservation: Reservation): Promise<void> {
  await db
    .update(aiQuotaReservations)
    .set({ status: 'released', settledAt: new Date() })
    .where(and(eq(aiQuotaReservations.id, reservation.id), eq(aiQuotaReservations.status, 'reserved')));
}

/** Words per output token, for a recovered call whose text was never seen (the ledger's estimate, not a count). */
export const RECOVERED_WORDS_PER_TOKEN = 0.75;

/**
 * Reaper (WS4 G2): settles reservations that expired unsettled — the worker
 * died, or the gateway's own commit failed after its retries.
 *
 * Every attempt's usage row is written before settlement and names its
 * reservation, so a reservation whose call reached a provider is committed
 * from those rows (tokens, cost, the project; a request when an attempt
 * succeeded and the call counted as one; words estimated from the output
 * tokens) instead of being released unbilled. One that consumed nothing is
 * released, as before. `commit` is idempotent under the user lock, so a
 * concurrent sweep, or a late commit by the call itself, never charges twice.
 */
export async function settleExpired(limit = 200): Promise<{ released: number; recovered: number }> {
  const expired = await db
    .select()
    .from(aiQuotaReservations)
    .where(and(eq(aiQuotaReservations.status, 'reserved'), lt(aiQuotaReservations.expiresAt, sql`now()`)))
    .limit(limit);

  let released = 0;
  let recovered = 0;
  for (const reservation of expired) {
    const attempts = await db
      .select()
      .from(aiUsageEvents)
      .where(eq(aiUsageEvents.reservationId, reservation.id))
      .orderBy(aiUsageEvents.attempt);
    const tokens = (row: (typeof attempts)[number]) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    const consumed = attempts.filter((row) => tokens(row) > 0);
    if (consumed.length === 0) {
      const rows = await db
        .update(aiQuotaReservations)
        .set({ status: 'released', settledAt: new Date() })
        .where(and(eq(aiQuotaReservations.id, reservation.id), eq(aiQuotaReservations.status, 'reserved')))
        .returning({ id: aiQuotaReservations.id });
      released += rows.length;
      continue;
    }
    const served = attempts.filter((row) => row.status === 'succeeded').at(-1);
    const last = served ?? consumed.at(-1)!;
    const wrote = await commit({
      reservation,
      countsAsRequest: Boolean(served) && reservation.requests > 0,
      outputText: '',
      words: served ? Math.round(served.outputTokens * RECOVERED_WORDS_PER_TOKEN) : 0,
      projectId: attempts.find((row) => row.projectId)?.projectId ?? null,
      provider: last.provider,
      model: last.model,
      tokensIn: consumed.reduce((sum, row) => sum + row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens, 0),
      tokensOut: consumed.reduce((sum, row) => sum + row.outputTokens, 0),
      costMicroUsd: attempts.reduce((sum, row) => sum + row.costMicroUsd, 0),
    });
    if (wrote) recovered += 1;
  }
  return { released, recovered };
}
