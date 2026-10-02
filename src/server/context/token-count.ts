/**
 * Token counting for context budgets (P1-E): the interface only.
 *
 * The context assembler v2 fits what it sends into a budget measured in the
 * tokens of the model that will read it. This module fixes the shape of that
 * measurement so the assembler can be written against it; the decision on how
 * each provider is counted is recorded in `docs/phase1/P1E_REPORT.md` and is
 * to be made explicitly before the assembler PR.
 *
 * Constraints already decided (PR #1):
 * - **Offline.** Counting never calls a provider: no token-count API, no
 *   network, no new metering. A counter is a pure function of the text.
 * - **Provider-aware.** Each provider (and, where it matters, model family)
 *   may count differently; the assembler asks for the counter of the model the
 *   call is routed to.
 * - **Conservative fallback.** Until a provider has an exact offline counter,
 *   it uses the existing script-aware estimate, which over-counts rather than
 *   under-counts, so a budget is never exceeded by a counting error.
 */

import { estimateTokens } from '@/ai/provider';

export type TokenProvider = 'anthropic' | 'openai' | 'google';

export interface TokenCounter {
  /** Which provider this counter is for, or `estimate` for the fallback. */
  readonly provider: TokenProvider | 'estimate';
  /** True when the count is exact for that provider's tokenizer, false for an estimate. */
  readonly exact: boolean;
  /** Tokens `text` costs. Pure and synchronous: no network, no metering. */
  count(text: string): number;
}

/** The fallback for every provider until an exact offline counter is chosen. */
export const estimateCounter: TokenCounter = {
  provider: 'estimate',
  exact: false,
  count: (text) => estimateTokens(text),
};

const counters = new Map<TokenProvider, TokenCounter>();

/**
 * The counter for a provider's model. Today every provider gets the estimate;
 * an exact counter, once chosen, is registered with `registerTokenCounter`.
 */
export function tokenCounterFor(provider: TokenProvider, _model?: string): TokenCounter {
  return counters.get(provider) ?? estimateCounter;
}

/** Registers an exact offline counter for a provider (and, for tests, replaces or clears one). */
export function registerTokenCounter(provider: TokenProvider, counter: TokenCounter | null): void {
  if (counter) counters.set(provider, counter);
  else counters.delete(provider);
}
