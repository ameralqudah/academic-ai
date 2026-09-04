/**
 * Deciding what fits.
 *
 * The old rule was "the last six messages". It is cheap and it is wrong in a
 * specific way: the message that matters is often not recent. A researcher who
 * said "always cite in APA" twenty turns ago meant it, and a `slice(-6)` forgot
 * it on turn seven.
 *
 * So fragments are scored, deduplicated, and then fitted to a budget in an
 * order that keeps what cannot be lost. No vector search here — that is a later
 * phase, and the scoring below is deliberately simple enough to be checked by
 * reading it.
 */

import type { ContextEnvelope, ContextFragment, ContextPurpose } from './envelope';

/**
 * Words too common to distinguish anything.
 *
 * Shared in spirit with the search relevance filter, which learned the same
 * lesson: matching on "التعلم" returned ten papers about learning disabilities
 * for a query about hybrid learning, because the common word carries no
 * information about the topic.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'and', 'or', 'to', 'with', 'is', 'are',
  'this', 'that', 'it', 'as', 'be', 'was', 'were', 'from', 'by', 'at',
  'في', 'من', 'على', 'عن', 'إلى', 'الى', 'مع', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي',
  'ما', 'أن', 'إن', 'كان', 'بين', 'حول', 'هو', 'هي',
]);

/** The distinctive words in a piece of text. */
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((word) => (word.length > 4 && word.startsWith('ال') ? word.slice(2) : word))
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

/**
 * How much a fragment has to do with the request.
 *
 * Term overlap, weighted by authority and recency. Crude on purpose: a score
 * that cannot be explained cannot be debugged, and the alternative — an
 * embedding lookup — is a later phase with its own infrastructure.
 */
export function scoreRelevance(
  fragment: ContextFragment,
  request: string,
  options: { purpose: ContextPurpose; now?: number } = { purpose: 'answer' },
): number {
  const requestTerms = terms(request);
  const fragmentTerms = terms(fragment.content);

  let overlap = 0;
  for (const term of requestTerms) if (fragmentTerms.has(term)) overlap += 1;

  const lexical = requestTerms.size === 0 ? 0.3 : Math.min(1, overlap / Math.min(requestTerms.size, 6));

  /*
   * Authority raises the floor rather than the ceiling.
   *
   * An instruction that shares no words with the request still applies —
   * "answer in Arabic" has nothing lexically in common with "explain
   * Cronbach's alpha" and governs it completely. Scoring it purely on overlap
   * would drop exactly the fragments that must never be dropped.
   */
  const floor: Record<ContextFragment['authority'], number> = {
    'user-instruction': 0.95,
    'user-content': 0.4,
    'project-data': 0.35,
    'tool-result': 0.45,
    'external-evidence': 0.3,
    /* Drafts start low: useful for continuity, dangerous as evidence. */
    'model-generated': 0.15,
  };

  /*
   * Recency, applied only to conversation. A recent message is more likely to
   * be what "it" refers to; a recent source is not more true than an older one,
   * and decaying evidence by age would quietly prefer new papers to good ones.
   */
  let recency = 0;

  if (fragment.kind === 'conversation' && fragment.provenance.at) {
    const age = (options.now ?? Date.now()) - new Date(fragment.provenance.at).getTime();
    const hours = age / 3_600_000;
    recency = hours < 1 ? 0.3 : hours < 24 ? 0.15 : 0;
  }

  /*
   * What each purpose actually needs. A planner wants to know what exists; a
   * verifier wants the claim and its sources and has no use for chat history.
   */
  const purposeWeight: Record<ContextPurpose, Partial<Record<ContextFragment['kind'], number>>> = {
    route: { conversation: 0.3, instruction: 0.2 },
    plan: { project: 0.25, file: 0.25, task: 0.2, instruction: 0.2 },
    execute: { task: 0.3, file: 0.2, research: 0.2, 'tool-result': 0.2 },
    answer: { conversation: 0.2, research: 0.2, artifact: 0.15 },
    verify: { research: 0.35, 'tool-result': 0.3 },
  };

  const boost = purposeWeight[options.purpose][fragment.kind] ?? 0;

  return Math.min(1, Math.max(floor[fragment.authority], lexical * 0.6 + recency + boost));
}

/**
 * Removes fragments that say the same thing.
 *
 * Two searches on one topic return overlapping sources, and a draft quoted back
 * into context duplicates the draft. Paying for the same tokens twice is the
 * visible cost; the hidden one is that repetition reads to a model as emphasis.
 *
 * The higher-authority copy is kept: if a user's own words and a model's
 * paraphrase of them collide, the user's words are what should survive.
 */
export function deduplicate(fragments: ContextFragment[]): ContextFragment[] {
  const rank: Record<ContextFragment['authority'], number> = {
    'user-instruction': 6,
    'user-content': 5,
    'project-data': 4,
    'tool-result': 3,
    'external-evidence': 2,
    'model-generated': 1,
  };

  const kept: ContextFragment[] = [];
  const seen = new Map<string, number>();

  /* Highest authority first, so the copy that survives is the one that should. */
  const ordered = [...fragments].sort((a, b) => rank[b.authority] - rank[a.authority]);

  for (const candidate of ordered) {
    const signature = normaliseForComparison(candidate.content);

    /* Identical text, whatever it came from. */
    if (seen.has(signature)) continue;

    /*
     * Near-identical: the same locator, which for evidence means the same
     * source found twice.
     */
    const locator = candidate.provenance.locator?.toLowerCase();

    if (locator && kept.some((entry) => entry.provenance.locator?.toLowerCase() === locator)) {
      continue;
    }

    seen.set(signature, kept.length);
    kept.push(candidate);
  }

  return kept;
}

function normaliseForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064b-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 400);
}

/**
 * Fits fragments to a token budget.
 *
 * Pinned fragments go in first and are never dropped. What remains is taken by
 * relevance until the budget is spent, and everything left out is recorded —
 * a model working from half the evidence should be known to be doing so.
 *
 * Pinned content exceeding the budget is kept anyway. A budget that silently
 * discards the user's instructions produces work they did not ask for, which is
 * worse than a call that costs more than planned.
 */
export function fitToBudget(
  fragments: ContextFragment[],
  maxTokens: number,
): { kept: ContextFragment[]; omitted: ContextEnvelope['omitted']; usedTokens: number } {
  const pinned = fragments.filter((entry) => entry.pinned);
  const rest = fragments
    .filter((entry) => !entry.pinned)
    .sort((a, b) => b.relevance - a.relevance);

  const kept = [...pinned];
  let used = pinned.reduce((total, entry) => total + entry.tokens, 0);

  const dropped: ContextFragment[] = [];

  for (const candidate of rest) {
    if (used + candidate.tokens <= maxTokens) {
      kept.push(candidate);
      used += candidate.tokens;
    } else {
      dropped.push(candidate);
    }
  }

  /* Grouped, so a caller can see that evidence was cut rather than chat. */
  const omitted: ContextEnvelope['omitted'] = [];

  for (const entry of dropped) {
    const existing = omitted.find(
      (group) => group.kind === entry.kind && group.authority === entry.authority,
    );

    if (existing) {
      existing.count += 1;
      existing.tokens += entry.tokens;
    } else {
      omitted.push({ kind: entry.kind, authority: entry.authority, count: 1, tokens: entry.tokens });
    }
  }

  return { kept, omitted, usedTokens: used };
}
