/**
 * The Context Assembler V2 (P1-E, PR #2), behind `FF_CONTEXT_V2`.
 *
 * What changes from v1 (`manager.buildContext`), and only this:
 *
 * 1. **Conversation turns are one chronological block.** They are taken out of
 *    relevance scoring and authority sorting entirely, kept from the newest
 *    backwards when the budget is short, and rendered oldest first
 *    (`turns.ts`).
 * 2. **A project summary snapshot is always present**, member-scoped, built
 *    from v1 project data only (`snapshot.ts`). A project the caller is not a
 *    member of is treated as no project at all: it reaches no other collector
 *    either, so a legacy creator-only record filed under it is not shown.
 * 3. **Claim references are rendered before assembly** (`claims.ts`): the
 *    claim's stored text, or `[unresolved claim]`; never the raw token.
 * 4. **Budgets are measured by a `TokenCounter`** (`../token-count.ts`), the
 *    conservative offline estimate until an exact counter is registered.
 *
 * Everything else — the collectors, relevance, deduplication and the
 * authority headings for the non-conversation fragments — is v1's, unchanged.
 * No graph context is added here: graph-derived content is a later PR and
 * needs `FF_CONTEXT_V2` and `FF_GRAPH` both on. Nothing here calls a model.
 */

import { logger } from '@/lib/logger';

import { BUDGETS } from '../budgets';
import { renderEnvelope, type ContextEnvelope, type ContextFragment } from '../envelope';
import { graphContextEnabled } from '../flags';
import type { BuildContextInput } from '../manager';
import { deduplicate, fitToBudget, scoreRelevance } from '../select';
import { collectFragments } from '../sources';
import { estimateCounter, tokenCounterFor, type TokenCounter, type TokenProvider } from '../token-count';

import { claimIdsAcross, renderClaims, resolveClaimTexts, scrubClaimTokens } from './claims';
import { projectSnapshot } from './snapshot';
import { fitTurns } from './turns';

/**
 * The share of the room left after pinned fragments that the conversation may
 * take. What the conversation does not use goes to the other fragments.
 */
export const TURN_SHARE = 0.5;

export interface BuildContextV2Input extends BuildContextInput {
  locale?: 'ar' | 'en';
  /** The provider the call is routed to, for its counter. */
  tokenProvider?: TokenProvider;
  /** Overrides the counter (tests, or a caller that already has one). */
  counter?: TokenCounter;
}

export interface ContextV2 {
  prompt: string;
  envelope: ContextEnvelope;
  /** The request with its claim references rendered the same way, for the message the model reads. */
  request: string;
}

/** v1's reading order for the fragments that are not conversation turns. */
const AUTHORITY_ORDER: Record<ContextFragment['authority'], number> = {
  'user-instruction': 0,
  'user-document': 1,
  'project-data': 2,
  'tool-result': 3,
  'external-evidence': 4,
  'user-content': 5,
  'model-generated': 6,
};

const TURNS_HEADING = {
  en: "The conversation so far, oldest first — the user's turns say what they want; the assistant's turns are earlier drafts, not evidence",
  ar: 'المحادثة حتى الآن، من الأقدم إلى الأحدث — أدوار المستخدم تبيّن ما يريد؛ وأدوار المساعد مسوّدات سابقة وليست دليلًا',
} as const;

const SNAPSHOT_HEADING = { en: 'Project snapshot', ar: 'لمحة المشروع' } as const;

const earlierTurns = (count: number, locale: 'ar' | 'en') =>
  locale === 'ar' ? `_(${count} من الأدوار الأقدم لم تتّسع لها المساحة.)_` : `_(${count} earlier turns did not fit and are not shown.)_`;

export async function buildContextV2(input: BuildContextV2Input): Promise<ContextV2> {
  const startedAt = Date.now();
  const locale = input.locale ?? 'en';
  const counter = input.counter ?? (input.tokenProvider ? tokenCounterFor(input.tokenProvider) : estimateCounter);

  const snapshot = await projectSnapshot({ userId: input.userId, projectId: input.projectId ?? null, locale });

  /* Only a project the caller is a member of reaches the collectors. */
  const collected = await collectFragments({ ...input, projectId: snapshot.projectId }, new Set(['project']));
  const all = [...collected, ...(input.additional ?? [])];

  /* Claim references, rendered before anything is measured or assembled. */
  const ids = claimIdsAcross([snapshot.fragment.content, input.request, ...all.map((entry) => entry.content)]);
  const rendered = await resolveClaimTexts(ids, { projectId: snapshot.projectId, userId: input.userId, graph: graphContextEnabled() });
  const measure = (entry: ContextFragment): ContextFragment => {
    const content = renderClaims(entry.content, rendered, locale);
    return { ...entry, content, tokens: counter.count(content) };
  };

  const snapshotFragment = measure(snapshot.fragment);
  const turns = all.filter((entry) => entry.kind === 'conversation').map(measure);
  const others = all.filter((entry) => entry.kind !== 'conversation').map(measure);

  const maxTokens = input.maxTokens ?? BUDGETS[input.purpose];
  const pinnedTokens = snapshotFragment.tokens + others.filter((entry) => entry.pinned).reduce((total, entry) => total + entry.tokens, 0);
  const room = Math.max(0, maxTokens - pinnedTokens);

  const fittedTurns = fitTurns(turns, Math.floor(room * TURN_SHARE), counter);

  const scored = others.map((entry) => ({ ...entry, relevance: scoreRelevance(entry, input.request, { purpose: input.purpose }) }));
  const unique = deduplicate(scored);
  const fitted = fitToBudget(unique, Math.max(0, maxTokens - snapshotFragment.tokens - fittedTurns.usedTokens));
  fitted.kept.sort((a, b) => AUTHORITY_ORDER[a.authority] - AUTHORITY_ORDER[b.authority] || b.relevance - a.relevance);

  const omitted = [...fitted.omitted];
  for (const turn of fittedTurns.dropped) {
    const group = omitted.find((entry) => entry.kind === turn.kind && entry.authority === turn.authority);
    if (group) {
      group.count += 1;
      group.tokens += turn.tokens;
    } else omitted.push({ kind: turn.kind, authority: turn.authority, count: 1, tokens: turn.tokens });
  }

  const envelope: ContextEnvelope = {
    purpose: input.purpose,
    fragments: [snapshotFragment, ...fitted.kept],
    turns: fittedTurns.kept,
    budget: { maxTokens, usedTokens: snapshotFragment.tokens + fitted.usedTokens + fittedTurns.usedTokens },
    omitted,
  };

  const prompt = scrubClaimTokens(renderContextV2(envelope, locale, fittedTurns.dropped.length), locale);

  logger.info('context.built', {
    version: 2,
    purpose: input.purpose,
    collected: all.length,
    turns: turns.length,
    turnsKept: fittedTurns.kept.length,
    kept: fitted.kept.length,
    claims: ids.length,
    claimsRendered: rendered.size,
    usedTokens: envelope.budget.usedTokens,
    maxTokens,
    counter: counter.provider,
    ms: Date.now() - startedAt,
  });

  return { prompt, envelope, request: renderClaims(input.request, rendered, locale) };
}

/**
 * The prompt: the snapshot first, then v1's authority groups for everything
 * that is not conversation, then the conversation in the order it was said.
 */
export function renderContextV2(envelope: ContextEnvelope, locale: 'ar' | 'en', droppedTurns = 0): string {
  const [snapshot, ...rest] = envelope.fragments;
  const parts: string[] = [];
  if (snapshot) parts.push(`## ${SNAPSHOT_HEADING[locale]}`, snapshot.content);

  const groups = renderEnvelope({ ...envelope, fragments: rest }, locale);
  if (groups) parts.push(groups);

  const turns = envelope.turns ?? [];
  if (turns.length > 0 || droppedTurns > 0) {
    parts.push(`## ${TURNS_HEADING[locale]}`);
    if (droppedTurns > 0) parts.push(earlierTurns(droppedTurns, locale));
    for (const turn of turns) parts.push(turn.content);
  }

  return parts.join('\n\n');
}
