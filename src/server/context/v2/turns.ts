/**
 * Conversation turns for Context V2 (P1-E): chronological, never re-ranked.
 *
 * The v1 builder scored each turn for relevance and sorted the envelope by
 * authority, so the user's turns and the assistant's were read in two
 * separate groups and in relevance order. A model reading "make it shorter"
 * after that cannot tell which "it" came last. V2 keeps the conversation as
 * one block, in the order it was said:
 *
 * - The order is the order of the turns: by time, ties kept as given. No
 *   relevance score and no authority rank ever enters it.
 * - When the budget is short, turns are kept from the newest backwards and the
 *   oldest are dropped. What is kept is a contiguous, most recent stretch, so
 *   no turn is ever missing from the middle of the conversation.
 *
 * Pure: no database, no model, no clock.
 */

import type { ContextFragment } from '../envelope';
import type { TokenCounter } from '../token-count';

export interface FittedTurns {
  /** The kept turns, oldest first. */
  kept: ContextFragment[];
  /** The oldest turns that did not fit, oldest first, measured by the counter. */
  dropped: ContextFragment[];
  usedTokens: number;
}

const timeOf = (turn: ContextFragment) => {
  const at = turn.provenance.at ? Date.parse(turn.provenance.at) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/**
 * The turns in the order they were said. Sorted by time with the given order
 * breaking ties (and placing a turn with no time where it was given), so a
 * stable input stays exactly as it is.
 */
export function chronological(turns: readonly ContextFragment[]): ContextFragment[] {
  return turns
    .map((turn, index) => ({ turn, index, at: timeOf(turn) }))
    .sort((a, b) => (a.at !== null && b.at !== null && a.at !== b.at ? a.at - b.at : a.index - b.index))
    .map((entry) => entry.turn);
}

/**
 * Fits the turns to `maxTokens`, measured by `counter`: newest first until
 * the next older turn would not fit, then stops (an older, shorter turn is not
 * slipped in past a gap). Returned oldest first.
 */
export function fitTurns(turns: readonly ContextFragment[], maxTokens: number, counter: TokenCounter): FittedTurns {
  const ordered = chronological(turns);
  const kept: ContextFragment[] = [];
  let used = 0;
  let index = ordered.length - 1;

  for (; index >= 0; index -= 1) {
    const turn = ordered[index]!;
    const tokens = counter.count(turn.content);
    if (used + tokens > maxTokens) break;
    kept.push({ ...turn, tokens });
    used += tokens;
  }

  return {
    kept: kept.reverse(),
    dropped: ordered.slice(0, index + 1).map((turn) => ({ ...turn, tokens: counter.count(turn.content) })),
    usedTokens: used,
  };
}
