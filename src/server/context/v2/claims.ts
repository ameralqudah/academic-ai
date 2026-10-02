/**
 * Claim references in model context (P1-E, Context V2).
 *
 * A section, a draft or a turn may name a claim as `{{claim:<id>}}`. A model
 * that reads the raw token sees an opaque id and may echo it, guess at it, or
 * write numbers it imagines the claim holds. So before context is assembled,
 * every reference is replaced:
 *
 * - a claim that resolves — in the caller's project, current, and verified by
 *   the same checks a section save and an export apply (WS3-D, D1/D3) —
 *   becomes its stored text, rendered when the claim was written, never
 *   recomputed;
 * - anything else becomes the visible marker `[unresolved claim]`. Nothing is
 *   reconstructed, and the raw token is never kept.
 *
 * Claims live in the Research Graph, so they are resolved only when graph
 * context is on (`FF_CONTEXT_V2` and `FF_GRAPH`); with the graph off every
 * reference is the marker. After assembly the whole prompt is scrubbed once
 * more (`scrubClaimTokens`), so a reference that arrived inside a claim's own
 * text, or in a spelling the strict pattern does not match, still never
 * reaches a model.
 */

import { logger } from '@/lib/logger';
import { claimIdsIn, renderClaimTokens } from '@/server/integrity/claims';
import { claimTraceability } from '@/server/services/section-claims';

export const UNRESOLVED_CLAIM_MARKER = { en: '[unresolved claim]', ar: '[ادعاء غير محلول]' } as const;

/** Any claim-reference-shaped token, loosely: spacing and case variants included. */
const ANY_CLAIM_TOKEN = /\{\{\s*claim\s*:[^{}]*\}\}/gi;

/** Whether `text` still holds anything shaped like a claim reference. */
export function hasClaimToken(text: string): boolean {
  ANY_CLAIM_TOKEN.lastIndex = 0;
  return ANY_CLAIM_TOKEN.test(text);
}

/** Every claim id referenced across `texts`, unique, in order of first appearance. */
export function claimIdsAcross(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => claimIdsIn(text)))];
}

/**
 * The stored text of each referenced claim that resolves, by id. Empty when
 * graph context is off, when there is no project, or when the lookup fails —
 * every reference then renders as the marker, which is the safe outcome.
 */
export async function resolveClaimTexts(
  ids: readonly string[],
  scope: { projectId: string | null; userId: string; graph: boolean },
): Promise<Map<string, string>> {
  if (!scope.graph || !scope.projectId || ids.length === 0) return new Map();
  try {
    const traces = await claimTraceability(scope.projectId, scope.userId, ids);
    return new Map(traces.flatMap((trace) => (trace.status === 'current' && trace.text ? [[trace.id, trace.text] as const] : [])));
  } catch (error) {
    logger.warn('context.claimsUnresolved', { count: ids.length, error: String(error).slice(0, 200) });
    return new Map();
  }
}

/** `text` with each reference rendered from `rendered`, or the marker. */
export function renderClaims(text: string, rendered: ReadonlyMap<string, string>, locale: 'ar' | 'en'): string {
  return scrubClaimTokens(renderClaimTokens(text, rendered, UNRESOLVED_CLAIM_MARKER[locale]), locale);
}

/** The last pass: anything still shaped like a claim reference becomes the marker. */
export function scrubClaimTokens(text: string, locale: 'ar' | 'en'): string {
  return text.replace(ANY_CLAIM_TOKEN, UNRESOLVED_CLAIM_MARKER[locale]);
}
