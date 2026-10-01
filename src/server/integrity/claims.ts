/**
 * Claim references in manuscript sections (WS3-D, D1).
 *
 * A section names a verified claim by `{{claim:<id>}}`. The reference, not a
 * copy of the claim's numbers, is what the section's text records: the claim
 * (written only through the strict claim path, WS3-A) carries the numbers and
 * their evidence. Callers validate every referenced claim before the text is
 * saved (`section-claims.ts`); this module only reads and rewrites the tokens.
 *
 * Pure and deterministic, like the rest of the guard.
 */

/** `{{claim:<id>}}`. The id part is bounded and has no braces or spaces; a malformed id is still a reference, refused as not found. */
const CLAIM_TOKEN = /\{\{claim:([^{}\s]{1,100})\}\}/g;

/** The ids the text references, unique, in order of first appearance. */
export function claimIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(CLAIM_TOKEN)].map((match) => match[1]!))];
}

/**
 * The text with every claim reference blanked to spaces of the same length,
 * for the number guard: a reference is not a number the text wrote (its id
 * may carry digits), and offsets stay those of the original text.
 */
export function blankClaimTokens(text: string): string {
  return text.replace(CLAIM_TOKEN, (token) => ' '.repeat(token.length));
}

/** The text with each reference to one of `ids` replaced by `replacement` (other references are kept). */
export function replaceClaimTokens(text: string, ids: ReadonlySet<string>, replacement: string): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(CLAIM_TOKEN, (token, id: string) => {
    if (!ids.has(id)) return token;
    replaced += 1;
    return replacement;
  });
  return { text: out, replaced };
}

/**
 * WS3-D (D3): the text a reader sees. Each reference to a claim in `rendered`
 * becomes that claim's stored text (rendered from recorded estimates when the
 * claim was written, never recomputed here); every other reference becomes
 * `fallback` (the quarantine marker). No raw `{{claim:…}}` survives.
 */
export function renderClaimTokens(text: string, rendered: ReadonlyMap<string, string>, fallback: string): string {
  return text.replace(CLAIM_TOKEN, (_token, id: string) => rendered.get(id) ?? fallback);
}
