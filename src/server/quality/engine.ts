/**
 * Checking academic work before it reaches a supervisor.
 *
 * Built as infrastructure rather than as a feature of one workflow, because the
 * same checks apply everywhere: a literature review, a deep research report, a
 * generated chapter and a final Word file all need their citations to match
 * their references and their claims to have sources. One engine, called by all
 * of them, means a rule improved once improves everywhere.
 *
 * **It reports; it never edits.** Not a stylistic preference — a checker that
 * rewrites would remove a real reference it misjudged, and the researcher would
 * never know. Every finding names what is wrong and where, and the researcher
 * decides. A flag they dismiss because it is their own data costs a second; a
 * source silently deleted costs a viva.
 *
 * **The result is structured, not a score.** A single number would collapse
 * "two references have no year" and "eleven citations point at nothing" into
 * one figure that hides which of them matters.
 */

import { logger } from '@/lib/logger';

import { analyseClaims, type Claim } from './claims';
import { severityOf, verifyDois, type DoiResult } from './doi';
import {
  checkReferenceShape,
  fabricationSignals,
  inferKind,
  type Reference,
  type SourceIssue,
} from './sources';

export type CheckStatus = 'pass' | 'attention' | 'fail' | 'not-applicable';

export interface QualityFinding {
  /** A stable key the interface resolves to a sentence in either language. */
  code: string;
  severity: 'error' | 'warning' | 'info';
  /** What it concerns: a reference id, a citation marker, an offset. */
  target?: string;
  detail?: Record<string, string | number>;
}

export interface QualityReport {
  /** How much of what needs a source has one. */
  citationCoverage: {
    status: CheckStatus;
    claimsNeedingSource: number;
    claimsWithSource: number;
    ratio: number;
  };

  /** Whether citations and references correspond in both directions. */
  citationReferenceConsistency: {
    status: CheckStatus;
    /** Cited in the text, absent from the reference list. */
    citedButMissing: string[];
    /** In the reference list, never cited. */
    listedButUncited: string[];
  };

  /** DOI results, for the references that have one. */
  doiVerification: {
    status: CheckStatus;
    checked: number;
    verified: number;
    notFound: number;
    mismatched: number;
    /** Could not be reached — not a finding against the source. */
    unchecked: number;
    results: DoiResult[];
  };

  /** Whether each reference has what its kind needs. */
  sourceValidity: {
    status: CheckStatus;
    issues: SourceIssue[];
  };

  /** Claims asserting something external with no source named. */
  unsupportedClaims: {
    status: CheckStatus;
    count: number;
    /** The sentences, so the researcher can judge each one. */
    claims: { text: string; offset: number; kind: string }[];
  };

  /** References showing signs of invention. Flagged, never removed. */
  fabricatedSourceRisk: {
    status: CheckStatus;
    flagged: { referenceId: string; signals: string[] }[];
  };

  /** Whether reported statistics are internally coherent. */
  statisticalConsistency: {
    status: CheckStatus;
    findings: QualityFinding[];
  };

  /** Contradictions and terminology drift within the document. */
  internalConsistency: {
    status: CheckStatus;
    findings: QualityFinding[];
  };

  /** Structural problems in the document itself. */
  formattingIssues: {
    status: CheckStatus;
    findings: QualityFinding[];
  };

  warnings: QualityFinding[];
  errors: QualityFinding[];

  /**
   * The overall verdict.
   *
   * `fail` only for things that are wrong rather than incomplete: a citation
   * pointing at no reference, a malformed DOI, a journal article whose DOI does
   * not exist. An incomplete bibliography is `attention` — it is work in
   * progress, and calling it a failure would mark every honest draft red.
   */
  overallStatus: CheckStatus;
}

export interface QualityInput {
  /** The prose to check. */
  text: string;
  references: Reference[];
  /**
   * Passages the user wrote or supplied.
   *
   * Their own claims are not the generator's to justify — a researcher stating
   * what their data showed needs no citation for it.
   */
  userProvidedRanges?: { start: number; end: number }[];
  /** Skip network verification, for a fast check while drafting. */
  skipNetwork?: boolean;
  /** Reported statistics, when the caller has them structured. */
  statistics?: { label: string; value: number; kind: 'p' | 'r' | 'r2' | 'alpha' | 'percent' }[];
}

/**
 * Runs every check and returns the full picture.
 *
 * Network verification is the only slow part, and it is skippable — a draft
 * check should be instant, and a final check can afford eight seconds.
 */
export async function checkQuality(input: QualityInput): Promise<QualityReport> {
  const startedAt = Date.now();

  /* Kinds inferred once, so every check sees the same view of each reference. */
  const references = input.references.map((reference) => ({
    ...reference,
    kind: inferKind(reference),
  }));

  const analysis = analyseClaims(input.text, {
    userProvidedRanges: input.userProvidedRanges,
  });

  const warnings: QualityFinding[] = [];
  const errors: QualityFinding[] = [];

  /* ------------------------------ coverage ------------------------------- */

  const needing = analysis.claims.filter((claim) => claim.needsSource);
  const withSource = needing.filter((claim) => claim.citations.length > 0);

  const citationCoverage = {
    /*
     * No claims needing support is not a failure. A methodology chapter
     * describing procedure legitimately cites little, and reporting that as a
     * problem would push researchers to add citations where none belong.
     */
    status: (needing.length === 0
      ? 'not-applicable'
      : withSource.length / needing.length >= 0.8
        ? 'pass'
        : 'attention') as CheckStatus,
    claimsNeedingSource: needing.length,
    claimsWithSource: withSource.length,
    ratio: analysis.coverage,
  };

  /* --------------------------- correspondence ---------------------------- */

  const referenceIds = new Set(references.map((reference) => reference.id));

  /*
   * Author-year citations are matched loosely against reference ids, because a
   * document citing "(Smith, 2020)" has a reference keyed on something else.
   * Only numeric citations are checked strictly.
   */
  const numericCitations = analysis.citedIds.filter((id) => /^\d+$/.test(id));

  const citedButMissing = numericCitations.filter((id) => !referenceIds.has(id));
  const listedButUncited = references
    .filter((reference) => /^\d+$/.test(reference.id) && !analysis.citedIds.includes(reference.id))
    .map((reference) => reference.id);

  for (const id of citedButMissing) {
    /*
     * An error. A citation pointing at nothing is a broken document — the
     * reader follows `[7]` and finds no seventh reference — and it is also the
     * signature of text generated against a reference list that changed.
     */
    errors.push({ code: 'citation.noReference', severity: 'error', target: id });
  }

  for (const id of listedButUncited) {
    /*
     * A warning. An uncited reference is usually a leftover from an earlier
     * draft, which is untidy rather than wrong.
     */
    warnings.push({ code: 'reference.neverCited', severity: 'warning', target: id });
  }

  const citationReferenceConsistency = {
    status: (citedButMissing.length > 0
      ? 'fail'
      : listedButUncited.length > 0
        ? 'attention'
        : 'pass') as CheckStatus,
    citedButMissing,
    listedButUncited,
  };

  /* ------------------------------ the DOIs -------------------------------- */

  const withDoi = references.filter((reference) => reference.doi);
  let doiResults: DoiResult[] = [];

  if (!input.skipNetwork && withDoi.length > 0) {
    doiResults = await verifyDois(references);

    for (const result of doiResults) {
      const reference = references.find((entry) => entry.id === result.referenceId);
      if (!reference) continue;

      const severity = severityOf(result, reference);
      if (severity === 'info') continue;

      const finding: QualityFinding = {
        code: `doi.${result.status}`,
        severity,
        target: result.referenceId,
        detail: {
          doi: result.doi,
          ...(result.differences ? { differences: result.differences.join(', ') } : {}),
        },
      };

      if (severity === 'error') errors.push(finding);
      else warnings.push(finding);
    }
  }

  const notFound = doiResults.filter((result) => result.status === 'not-found').length;
  const mismatched = doiResults.filter((result) => result.status === 'mismatch').length;
  const unchecked = doiResults.filter((result) => result.status === 'unchecked').length;

  const doiVerification = {
    /*
     * No DOIs at all is `not-applicable`, not a failure. A bibliography of
     * books and reports legitimately has none, and marking that as a problem is
     * the mistake this whole design exists to avoid.
     */
    status: (withDoi.length === 0
      ? 'not-applicable'
      : input.skipNetwork
        ? 'not-applicable'
        : notFound > 0
          ? 'fail'
          : mismatched > 0
            ? 'attention'
            : 'pass') as CheckStatus,
    checked: doiResults.length,
    verified: doiResults.filter((result) => result.status === 'verified').length,
    notFound,
    mismatched,
    unchecked,
    results: doiResults,
  };

  /* --------------------------- source validity ---------------------------- */

  const shapeIssues = references.flatMap((reference) => checkReferenceShape(reference));

  for (const issue of shapeIssues) {
    if (issue.severity === 'error') {
      errors.push({
        code: `source.${issue.code}`,
        severity: 'error',
        target: issue.referenceId,
        detail: issue.detail,
      });
    } else if (issue.severity === 'warning') {
      warnings.push({
        code: `source.${issue.code}`,
        severity: 'warning',
        target: issue.referenceId,
        detail: issue.detail,
      });
    }
  }

  const sourceValidity = {
    status: (references.length === 0
      ? 'not-applicable'
      : shapeIssues.some((issue) => issue.severity === 'error')
        ? 'fail'
        : shapeIssues.some((issue) => issue.severity === 'warning')
          ? 'attention'
          : 'pass') as CheckStatus,
    issues: shapeIssues,
  };

  /* ------------------------- duplicate references ------------------------- */

  const seen = new Map<string, string>();

  for (const reference of references) {
    /* By DOI where there is one, by title and year otherwise. */
    const key = reference.doi
      ? `doi:${reference.doi.toLowerCase()}`
      : `title:${(reference.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}|${reference.year ?? ''}`;

    if (key === 'title:|') continue;

    const first = seen.get(key);

    if (first) {
      warnings.push({
        code: 'reference.duplicate',
        severity: 'warning',
        target: reference.id,
        detail: { duplicateOf: first },
      });
    } else {
      seen.set(key, reference.id);
    }
  }

  /* ------------------------ unsupported and risky ------------------------- */

  for (const claim of analysis.unsupported) {
    warnings.push({
      code: 'claim.unsupported',
      severity: 'warning',
      target: String(claim.offset),
      detail: { kind: claim.kind, text: claim.text.slice(0, 160) },
    });
  }

  const unsupportedClaims = {
    status: (analysis.unsupported.length === 0 ? 'pass' : 'attention') as CheckStatus,
    count: analysis.unsupported.length,
    claims: analysis.unsupported.map((claim: Claim) => ({
      text: claim.text,
      offset: claim.offset,
      kind: claim.kind,
    })),
  };

  const flagged = references
    .map((reference) => ({ referenceId: reference.id, signals: fabricationSignals(reference) }))
    .filter((entry) => entry.signals.length > 0);

  for (const entry of flagged) {
    warnings.push({
      code: 'reference.possiblyFabricated',
      severity: 'warning',
      target: entry.referenceId,
      detail: { signals: entry.signals.join(', ') },
    });
  }

  const fabricatedSourceRisk = {
    /*
     * `attention`, never `fail`. Every signal has innocent explanations, and a
     * verdict of failure on a suspicion would have researchers deleting real
     * sources to clear a red mark.
     */
    status: (flagged.length === 0 ? 'pass' : 'attention') as CheckStatus,
    flagged,
  };

  /* ---------------------------- the statistics ---------------------------- */

  const statisticalFindings = checkStatistics(input.statistics ?? []);
  for (const finding of statisticalFindings) {
    if (finding.severity === 'error') errors.push(finding);
    else warnings.push(finding);
  }

  const statisticalConsistency = {
    status: ((input.statistics ?? []).length === 0
      ? 'not-applicable'
      : statisticalFindings.some((finding) => finding.severity === 'error')
        ? 'fail'
        : statisticalFindings.length > 0
          ? 'attention'
          : 'pass') as CheckStatus,
    findings: statisticalFindings,
  };

  /* ----------------------- consistency and format ------------------------- */

  const internalFindings = checkInternalConsistency(input.text);
  for (const finding of internalFindings) warnings.push(finding);

  const formattingFindings = checkFormatting(input.text);
  for (const finding of formattingFindings) warnings.push(finding);

  logger.info('quality.checked', {
    references: references.length,
    claims: analysis.claims.length,
    unsupported: analysis.unsupported.length,
    errors: errors.length,
    warnings: warnings.length,
    ms: Date.now() - startedAt,
  });

  return {
    citationCoverage,
    citationReferenceConsistency,
    doiVerification,
    sourceValidity,
    unsupportedClaims,
    fabricatedSourceRisk,
    statisticalConsistency,
    internalConsistency: {
      status: (internalFindings.length === 0 ? 'pass' : 'attention') as CheckStatus,
      findings: internalFindings,
    },
    formattingIssues: {
      status: (formattingFindings.length === 0 ? 'pass' : 'attention') as CheckStatus,
      findings: formattingFindings,
    },
    warnings,
    errors,
    /*
     * Errors fail; warnings ask for attention. The distinction is between wrong
     * and incomplete, and it decides whether a researcher can submit.
     */
    overallStatus: (errors.length > 0 ? 'fail' : warnings.length > 0 ? 'attention' : 'pass') as CheckStatus,
  };
}

/**
 * Statistics that cannot be what they claim.
 *
 * Bounds only — a p-value above one, a correlation beyond ±1, a proportion over
 * a hundred. These are impossible rather than implausible, which is the only
 * judgement that can be made without the underlying data.
 */
function checkStatistics(
  statistics: NonNullable<QualityInput['statistics']>,
): QualityFinding[] {
  const findings: QualityFinding[] = [];

  for (const statistic of statistics) {
    const outOfBounds =
      (statistic.kind === 'p' && (statistic.value < 0 || statistic.value > 1)) ||
      (statistic.kind === 'r' && Math.abs(statistic.value) > 1) ||
      (statistic.kind === 'r2' && (statistic.value < 0 || statistic.value > 1)) ||
      (statistic.kind === 'alpha' && statistic.value > 1) ||
      (statistic.kind === 'percent' && (statistic.value < 0 || statistic.value > 100));

    if (outOfBounds) {
      findings.push({
        code: 'statistic.outOfRange',
        severity: 'error',
        target: statistic.label,
        detail: { value: statistic.value, kind: statistic.kind },
      });
    }

    /*
     * A negative alpha is possible and almost always means reverse-coded items
     * were not recoded — a specific, fixable cause worth naming rather than
     * reporting as a generic range problem.
     */
    if (statistic.kind === 'alpha' && statistic.value < 0) {
      findings.push({
        code: 'statistic.negativeAlpha',
        severity: 'warning',
        target: statistic.label,
        detail: { value: statistic.value },
      });
    }
  }

  return findings;
}

/**
 * Contradictions within the document.
 *
 * Deliberately narrow: numbers that disagree with themselves, which is
 * checkable. Whether an argument contradicts itself is a judgement this cannot
 * make, and pretending otherwise would produce confident nonsense.
 */
function checkInternalConsistency(text: string): QualityFinding[] {
  const findings: QualityFinding[] = [];

  /*
   * Sample size stated more than once with different values. Common when a
   * document is edited after the data changes, and invisible on a read-through.
   */
  const sampleSizes = new Set<number>();
  const patterns = [
    /\bn\s*=\s*(\d{2,6})\b/gi,
    /sample of (\d{2,6})/gi,
    /(\d{2,6})\s+(?:participants|respondents)/gi,
    /عينة (?:من )?(\d{2,6})/g,
    /(\d{2,6})\s+(?:مشاركًا|مستجيبًا|مفردة)/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);

    while (match) {
      const value = Number(match[1]);
      if (value >= 10 && value <= 100000) sampleSizes.add(value);
      match = pattern.exec(text);
    }
  }

  if (sampleSizes.size > 1) {
    findings.push({
      code: 'consistency.sampleSize',
      severity: 'warning',
      detail: { values: [...sampleSizes].join(', ') },
    });
  }

  return findings;
}

/** Structural problems visible in the text itself. */
function checkFormatting(text: string): QualityFinding[] {
  const findings: QualityFinding[] = [];

  /*
   * Placeholders left behind. `[TODO]`, `XXX`, `Lorem ipsum` — the marks of a
   * draft submitted by accident, and the kind of thing a supervisor notices
   * first.
   */
  const placeholders = text.match(/\[(TODO|TBD|XXX|PLACEHOLDER)\]|Lorem ipsum|\bTKTK\b/gi);

  if (placeholders) {
    findings.push({
      code: 'format.placeholder',
      severity: 'warning',
      detail: { count: placeholders.length, first: placeholders[0] ?? '' },
    });
  }

  /* An empty section: a heading with nothing under it. */
  const emptyHeadings = text.match(/^#{1,6}\s+.+\n+(?=#{1,6}\s)/gm);

  if (emptyHeadings && emptyHeadings.length > 0) {
    findings.push({
      code: 'format.emptySection',
      severity: 'warning',
      detail: { count: emptyHeadings.length },
    });
  }

  /*
   * A malformed citation: an opening bracket with a number and no close, which
   * is how `[12` reaches a document when text is edited around a citation.
   */
  const malformed = text.match(/\[\d+(?![\d\s,،-]*\])/g);

  if (malformed && malformed.length > 0) {
    findings.push({
      code: 'format.malformedCitation',
      severity: 'warning',
      detail: { count: malformed.length, first: malformed[0] ?? '' },
    });
  }

  return findings;
}
