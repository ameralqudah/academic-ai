/**
 * Building the context for one model call.
 *
 * The single entry point. Callers ask for an envelope by purpose and get
 * fragments selected, deduplicated and fitted to a budget — rather than each
 * caller deciding for itself, which is how this codebase ended up with
 * `slice(-6)`, `slice(-9)` and `listMessages(20)` all meaning "recent history"
 * and none of them meaning "what this call needs".
 *
 * **Nothing here fetches a model.** Building context is arithmetic over rows,
 * and keeping it that way means it can be tested without a provider, a key, or
 * a network — which is what the search relevance work taught, seven modules
 * ago, about coupling pure logic to services.
 */

import { logger } from '@/lib/logger';

import {
  renderEnvelope,
  type ContextEnvelope,
  type ContextFragment,
  type ContextPurpose,
} from './envelope';
import { deduplicate, fitToBudget, scoreRelevance } from './select';
import { collectFragments, type SourceScope } from './sources';

/**
 * How much room each kind of call gets.
 *
 * A routing decision needs almost nothing and is made on every message, so it
 * is cheap by design. A verification pass needs the claim and every source
 * behind it. Giving them the same budget means either the router is expensive
 * or the verifier is starved.
 */
const BUDGETS: Record<ContextPurpose, number> = {
  route: 800,
  plan: 3000,
  execute: 4000,
  answer: 5000,
  verify: 6000,
};

export interface BuildContextInput extends SourceScope {
  purpose: ContextPurpose;
  /** What the user asked, which relevance is scored against. */
  request: string;
  /** Overrides the default for this purpose. */
  maxTokens?: number;
  /** Extra fragments the caller already has — a step's declared inputs. */
  additional?: ContextFragment[];
}

/**
 * Assembles the context for one call.
 *
 * Order matters: collect, then score, then deduplicate, then fit. Scoring
 * before deduplication would waste work on copies; deduplicating after fitting
 * would leave a gap in the budget where a duplicate was removed.
 */
export async function buildContext(input: BuildContextInput): Promise<ContextEnvelope> {
  const startedAt = Date.now();

  const collected = await collectFragments(input);
  const all = [...collected, ...(input.additional ?? [])];

  const scored = all.map((entry) => ({
    ...entry,
    relevance: scoreRelevance(entry, input.request, { purpose: input.purpose }),
  }));

  const unique = deduplicate(scored);

  const maxTokens = input.maxTokens ?? BUDGETS[input.purpose];
  const { kept, omitted, usedTokens } = fitToBudget(unique, maxTokens);

  /*
   * Ordered for reading: instructions first, drafts last. The model reads top
   * to bottom, and what governs the answer should not be buried under what
   * merely informs it.
   */
  const order: Record<ContextFragment['authority'], number> = {
    'user-instruction': 0,
    'project-data': 1,
    'tool-result': 2,
    'external-evidence': 3,
    'user-content': 4,
    'model-generated': 5,
  };

  kept.sort((a, b) => order[a.authority] - order[b.authority] || b.relevance - a.relevance);

  logger.info('context.built', {
    purpose: input.purpose,
    collected: all.length,
    duplicatesRemoved: all.length - unique.length,
    kept: kept.length,
    omitted: omitted.reduce((total, group) => total + group.count, 0),
    usedTokens,
    maxTokens,
    ms: Date.now() - startedAt,
  });

  return {
    purpose: input.purpose,
    fragments: kept,
    budget: { maxTokens, usedTokens },
    omitted,
  };
}

/**
 * Context as a system prompt, ready for a model call.
 *
 * The convenience most callers want: they need a string, and assembling it from
 * fragments at each call site would put the authority ordering — the part that
 * keeps a draft from becoming evidence — in six places instead of one.
 */
export async function buildContextPrompt(
  input: BuildContextInput & { locale?: 'ar' | 'en' },
): Promise<{ prompt: string; envelope: ContextEnvelope }> {
  const envelope = await buildContext(input);

  return {
    prompt: renderEnvelope(envelope, input.locale ?? 'en'),
    envelope,
  };
}

export { BUDGETS };
export { describeOmissions } from './envelope';
