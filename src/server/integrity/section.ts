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
}

const MAX_FINDINGS = 20;

/** The record for a guard result. `legacy` is null when no analyses were checked against (not a results section). */
export function sectionIntegrity(input: {
  mode: 'model' | 'person';
  check: NumberCheck;
  legacy: LegacyAllowedValues | null;
  quarantined?: number;
}): SectionIntegrity {
  const withId = (entries: { id?: string; tier: LegacyResultTier }[]) =>
    entries.filter((entry): entry is { id: string; tier: LegacyResultTier } => typeof entry.id === 'string').map(({ id, tier }) => ({ id, tier }));
  return {
    mode: input.mode,
    guardVersion: input.check.guardVersion,
    quarantined: input.mode === 'model' ? (input.quarantined ?? 0) : 0,
    manual: input.mode === 'person' ? input.check.findings.length : 0,
    traced: input.check.traced.length,
    sources: withId(input.legacy?.used ?? []),
    excluded: withId(input.legacy?.excluded ?? []),
    findings: input.check.findings.slice(0, MAX_FINDINGS).map((found) => ({ text: found.text, value: found.value, kind: found.kind })),
  };
}
