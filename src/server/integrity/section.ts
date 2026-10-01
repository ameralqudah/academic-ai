/**
 * What the numeric guard found when a section version was saved (WS2 D2).
 *
 * Stored with the version (`section_versions.integrity`), so the link from a
 * section's text to the analyses behind it, and their tiers, is recorded when
 * the text is written rather than recomputed later. Versions saved before this
 * existed have no record (null); readers fall back to a fresh scan.
 *
 * - `model`: text a model wrote, quarantined before saving (WS2 N1):
 *   `quarantined` numbers were replaced by the marker.
 * - `person`: text a person wrote, never rewritten (WS2 N3): `manual`
 *   research numbers trace to no attached analysis. A flag for provenance,
 *   never a block on saving or approving.
 */

import type { LegacyAllowedValues, LegacyResultTier, NumberCheck, NumberSpan } from './numbers';

export interface SectionIntegrity {
  mode: 'model' | 'person';
  guardVersion: string;
  /** Model text: untraced numbers replaced by the quarantine marker. */
  quarantined: number;
  /** Person text: research numbers that trace to no attached analysis (flag only). */
  manual: number;
  /** Research numbers that trace to an attached analysis or to the instruction. */
  traced: number;
  /** The attached analyses the numbers were checked against, with their tiers. None is "verified". */
  sources: { id: string; tier: LegacyResultTier }[];
  /** Attached analyses left out (windowed: the first rows of a file only, WS2 D3). */
  excluded: { id: string; tier: LegacyResultTier }[];
  /** The first untraced numbers, for display. */
  findings: Pick<NumberSpan, 'text' | 'value' | 'kind'>[];
  /**
   * WS3-D (D1): the claims the text references as `{{claim:id}}`, each found
   * current and verified when the text was checked (strict claims, WS3-A).
   * Their research numbers count as `traced`. Absent when the text references none.
   */
  claims?: SectionClaim[];
  /** References that did not resolve when the text was checked (an export-time scan only: a save refuses or quarantines them). */
  unresolvedClaims?: UnresolvedClaim[];
}

export interface SectionClaim {
  id: string;
  /** Research numbers in the claim's text. */
  numbers: number;
}

export type UnresolvedClaimReason = 'not_found' | 'not_a_claim' | 'not_current' | 'not_verified';

export interface UnresolvedClaim {
  id: string;
  reason: UnresolvedClaimReason;
}

const MAX_FINDINGS = 20;

/** The record for a guard result. `legacy` is null when no analyses were checked against (not a results section). */
export function sectionIntegrity(input: {
  mode: 'model' | 'person';
  check: NumberCheck;
  legacy: LegacyAllowedValues | null;
  quarantined?: number;
  /** WS3-D (D1): the validated claims the text references, and any that did not resolve. */
  claims?: readonly SectionClaim[];
  unresolvedClaims?: readonly UnresolvedClaim[];
}): SectionIntegrity {
  const withId = (entries: { id?: string; tier: LegacyResultTier }[]) =>
    entries.filter((entry): entry is { id: string; tier: LegacyResultTier } => typeof entry.id === 'string').map(({ id, tier }) => ({ id, tier }));
  return {
    mode: input.mode,
    guardVersion: input.check.guardVersion,
    quarantined: input.mode === 'model' ? (input.quarantined ?? 0) : 0,
    manual: input.mode === 'person' ? input.check.findings.length : 0,
    traced: input.check.traced.length + (input.claims ?? []).reduce((sum, claim) => sum + claim.numbers, 0),
    sources: withId(input.legacy?.used ?? []),
    excluded: withId(input.legacy?.excluded ?? []),
    findings: input.check.findings.slice(0, MAX_FINDINGS).map((found) => ({ text: found.text, value: found.value, kind: found.kind })),
    ...(input.claims?.length ? { claims: input.claims.map(({ id, numbers }) => ({ id, numbers })) } : {}),
    ...(input.unresolvedClaims?.length ? { unresolvedClaims: input.unresolvedClaims.map(({ id, reason }) => ({ id, reason })) } : {}),
  };
}
