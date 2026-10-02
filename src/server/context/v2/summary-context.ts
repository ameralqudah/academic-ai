/**
 * The thread summary in Context V2 (P1-E, PR #4).
 *
 * The chronological block keeps the newest turns that fit (`turns.ts`). When
 * older turns had to be dropped, the conversation's latest summary stands in
 * for them, placed before the turns it precedes:
 *
 * - **No overlap.** A summary covers every turn up to its last message. A kept
 *   turn it covers is removed from the block (the summary already says it),
 *   so no turn is ever both summarised and shown. What is removed is the
 *   oldest end of the kept stretch, so the turns shown stay one contiguous,
 *   most recent, chronological run.
 * - **Only when it adds something.** Used when turns had to be dropped, or
 *   when it covers only history older than every loaded turn. With no
 *   summary, every turn shown verbatim, or a summary larger than the
 *   conversation's share of the budget, the block is exactly as without
 *   summaries.
 * - **Measured like a turn.** The summary is costed by the same counter and
 *   comes out of the conversation's share; the turns are refitted to what is
 *   left.
 * - **Owner only, fail safe.** It is read through the memory scope (RLS); if
 *   that is refused or fails, or its last message is gone, there is no
 *   summary and the context is built as before.
 *
 * The summary is the assistant's own text (`model-generated`, never
 * evidence); its numbers were checked by the numeric guard when it was
 * written (`summaries.ts`), and its claim references go through the claim
 * pass like everything else.
 */

import { logger } from '@/lib/logger';
import { latestThreadSummary } from '@/server/memory/repository';
import * as conversationsRepo from '@/server/repositories/conversations.repository';

import type { ContextFragment } from '../envelope';
import type { TokenCounter } from '../token-count';

import { chronological, fitTurns, type FittedTurns } from './turns';

export const SUMMARY_HEADING = {
  en: 'Summary of the earlier conversation (written by the assistant; not evidence):',
  ar: 'ملخص الجزء الأقدم من المحادثة (كتبه المساعد؛ وليس دليلًا):',
} as const;

export interface LoadedSummary {
  fragment: ContextFragment;
  throughMessageId: string;
  throughAt: number;
}

/** The conversation's latest summary for `userId`, ready to be measured, or null. Never throws. */
export async function loadSummary(userId: string, conversationId: string | null | undefined, locale: 'ar' | 'en'): Promise<LoadedSummary | null> {
  if (!conversationId) return null;
  try {
    const latest = await latestThreadSummary(userId, conversationId);
    if (!latest?.throughMessageId) return null;
    const through = await conversationsRepo.findMessageOwned(conversationId, userId, latest.throughMessageId);
    const throughAt = through?.createdAt ? through.createdAt.getTime() : Number.NaN;
    if (!Number.isFinite(throughAt)) return null;
    return {
      throughMessageId: latest.throughMessageId,
      throughAt,
      fragment: {
        id: `summary-v${latest.version}`,
        kind: 'summary',
        authority: 'model-generated',
        content: `${SUMMARY_HEADING[locale]}\n${latest.summary}`,
        provenance: { source: 'thread.summary', id: latest.id, at: new Date(throughAt).toISOString() },
        relevance: 1,
        pinned: false,
        tokens: 0,
      },
    };
  } catch (error) {
    logger.warn('context.summaryUnavailable', { error: String(error).slice(0, 200) });
    return null;
  }
}

export interface FittedWithSummary extends FittedTurns {
  /** The summary, measured, when it is used. */
  summary: ContextFragment | null;
  /** Turns the summary stands in for (not shown, not omitted). */
  covered: number;
}

/** Whether a turn is one the summary covers: its last message, or anything said up to then. */
function coveredBy(summary: LoadedSummary) {
  return (turn: ContextFragment) => {
    if (turn.provenance.id === summary.throughMessageId) return true;
    const at = turn.provenance.at ? Date.parse(turn.provenance.at) : Number.NaN;
    return Number.isFinite(at) && at <= summary.throughAt;
  };
}

/**
 * Fits the turns to `maxTokens`, with the summary standing in for dropped
 * ones. `summary.fragment` must already be measured (its `tokens` set).
 */
export function fitTurnsWithSummary(turns: readonly ContextFragment[], maxTokens: number, counter: TokenCounter, summary: LoadedSummary | null): FittedWithSummary {
  const plain = fitTurns(turns, maxTokens, counter);
  if (!summary || summary.fragment.tokens > maxTokens) return { ...plain, summary: null, covered: 0 };

  /*
   * Used when turns had to be dropped, or when it covers only history older
   * than every loaded turn (it then repeats nothing shown). When every turn
   * fits and the summary covers some of them, the turns are shown verbatim
   * and the summary is left out.
   */
  const isCovered = coveredBy(summary);
  const olderThanAll = !turns.some(isCovered);
  if (plain.dropped.length === 0 && !olderThanAll) return { ...plain, summary: null, covered: 0 };

  const refit = fitTurns(turns, maxTokens - summary.fragment.tokens, counter);
  const kept = chronological(refit.kept.filter((turn) => !isCovered(turn)));
  const dropped = refit.dropped.filter((turn) => !isCovered(turn));
  const covered = refit.kept.length - kept.length + (refit.dropped.length - dropped.length);

  return {
    kept,
    dropped,
    usedTokens: summary.fragment.tokens + kept.reduce((total, turn) => total + turn.tokens, 0),
    summary: summary.fragment,
    covered,
  };
}
