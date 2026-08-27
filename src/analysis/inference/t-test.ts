/**
 * The t family: one-sample, independent-samples, and paired.
 *
 * Three tests that look alike and answer different questions. The one that
 * causes trouble is the independent-samples test, because it has two forms and
 * the choice between them is usually made by habit rather than by the data.
 *
 * **Welch's t is the primary result here, always.**
 *
 * Student's t assumes the two populations have equal variances. That assumption
 * is rarely true and, more to the point, rarely checked: SPSS prints both rows
 * and a great many theses copy the top one. When variances differ *and* the
 * groups are unequal in size — which is the ordinary situation in survey
 * research, where you get the respondents you get — Student's t is not slightly
 * off. Its error rate departs badly from the nominal 5%, in either direction
 * depending on which group is larger.
 *
 * Welch's t drops the equal-variance assumption. Its cost when variances really
 * are equal is a small loss of degrees of freedom and a negligible loss of
 * power. That is a good trade at every sample size, which is why the modern
 * methodological recommendation is to use it by default rather than to test
 * first and then choose. This module follows that recommendation, and still
 * reports Student's t alongside — labelled as secondary — because examiners
 * expect to see it and because the comparison is informative when the two
 * disagree.
 *
 * Effect sizes are not optional. With four hundred respondents a difference of
 * no consequence clears p < .05, and a student who reports only the p-value has
 * reported the size of their sample.
 */

import { tQuantile, tSf, tTwoTailed } from '../distributions';
import { mean, standardDeviation, variance } from '../stats-core';
import {
  assessHomogeneity,
  assessNormality,
  independenceCheck,
} from './assumptions';
import {
  bandForCohensD,
  type AnalysisWarning,
  type AssumptionCheck,
  type EffectSize,
  type GroupEstimate,
  type InferentialResult,
} from './types';

/** Below this, a group is too small for the result to mean much. */
const MIN_GROUP_N = 3;
/** Below this, the estimate is unstable enough to say so. */
const SMALL_GROUP_N = 15;

export interface TTestOptions {
  /** Defaults to 0.95. */
  confidenceLevel?: number;
  /** The value being tested against, for the one-sample test. Defaults to 0. */
  mu?: number;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function estimateFor(
  label: string,
  values: number[],
  level: number,
): GroupEstimate {
  const n = values.length;
  const m = mean(values);
  const sd = standardDeviation(values);
  const se = n > 0 ? sd / Math.sqrt(n) : Number.NaN;

  const estimate: GroupEstimate = { label, n, mean: m, sd, se };

  if (n >= 2 && Number.isFinite(se) && se > 0) {
    const critical = tQuantile(1 - (1 - level) / 2, n - 1);
    estimate.confidenceInterval = {
      level,
      lower: m - critical * se,
      upper: m + critical * se,
    };
  }

  return estimate;
}

/**
 * Hedges' correction for small-sample bias in Cohen's d.
 *
 * Cohen's d systematically overstates the effect when samples are small — by
 * about 4% at n = 20, which is a size student research meets constantly. The
 * correction is a simple multiplier and there is no reason not to apply it, so
 * both are reported: d for comparability with the literature, g as the less
 * biased figure.
 */
function hedgesCorrection(df: number): number {
  if (df <= 1) return Number.NaN;
  return 1 - 3 / (4 * df - 1);
}

function sizeWarnings(groups: { label: string; n: number }[]): AnalysisWarning[] {
  const warnings: AnalysisWarning[] = [];

  const tiny = groups.filter((group) => group.n < SMALL_GROUP_N);
  if (tiny.length > 0) {
    warnings.push({
      code: 'small-group',
      severity: 'warning',
      columns: tiny.map((group) => group.label),
      params: { threshold: SMALL_GROUP_N, smallest: Math.min(...tiny.map((g) => g.n)) },
    });
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/*                             One-sample t-test                              */
/* -------------------------------------------------------------------------- */

/**
 * Tests whether a single mean differs from a fixed value.
 *
 * The typical use in this product's world: a Likert scale where the midpoint is
 * the neutral answer, and the question is whether respondents lean either side
 * of it. `mu` is that midpoint, and it must come from the researcher — guessing
 * it from the data would test whether the mean differs from itself.
 */
export function oneSampleTTest(
  values: number[],
  variableName: string,
  options: TTestOptions = {},
): InferentialResult {
  const level = options.confidenceLevel ?? 0.95;
  const mu = options.mu ?? 0;

  const clean = values.filter((value) => Number.isFinite(value));
  const dropped = values.length - clean.length;
  const n = clean.length;

  if (n < MIN_GROUP_N) {
    throw new TTestError('analysis.ttest.error.tooFewValues', { n, minimum: MIN_GROUP_N });
  }

  const m = mean(clean);
  const sd = standardDeviation(clean);

  if (sd === 0) {
    throw new TTestError('analysis.ttest.error.noVariance', { variable: variableName });
  }

  const se = sd / Math.sqrt(n);
  const t = (m - mu) / se;
  const df = n - 1;
  const p = tTwoTailed(t, df);

  const d = (m - mu) / sd;
  const g = d * hedgesCorrection(df);

  const normality = assessNormality(clean, variableName);

  return {
    test: 't.oneSample',
    variables: [variableName],
    statistic: { name: 't', value: t },
    df,
    pValue: p,
    effect: { name: 'cohensD', value: d, band: bandForCohensD(d) },
    estimates: [estimateFor(variableName, clean, level)],
    assumptions: [normality.check, independenceCheck()],
    warnings: [...normality.warnings, ...sizeWarnings([{ label: variableName, n }])],
    n,
    rowsSupplied: values.length,
    rowsDropped: dropped,
    missingPolicy: 'listwise',
    detail: {
      mu,
      meanDifference: m - mu,
      hedgesG: g,
      standardError: se,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                         Independent-samples t-test                         */
/* -------------------------------------------------------------------------- */

/**
 * Compares two independent groups. Welch's form is the primary result; see the
 * note at the top of this file for why.
 */
export function independentTTest(
  groupA: number[],
  groupB: number[],
  labels: [string, string],
  options: TTestOptions = {},
): InferentialResult {
  const level = options.confidenceLevel ?? 0.95;

  const a = groupA.filter((value) => Number.isFinite(value));
  const b = groupB.filter((value) => Number.isFinite(value));
  const dropped = groupA.length - a.length + (groupB.length - b.length);

  const nA = a.length;
  const nB = b.length;

  if (nA < MIN_GROUP_N || nB < MIN_GROUP_N) {
    throw new TTestError('analysis.ttest.error.groupTooSmall', {
      smallest: Math.min(nA, nB),
      minimum: MIN_GROUP_N,
    });
  }

  const meanA = mean(a);
  const meanB = mean(b);
  const varA = variance(a);
  const varB = variance(b);

  if (varA === 0 && varB === 0) {
    throw new TTestError('analysis.ttest.error.noVariance', { variable: labels.join(', ') });
  }

  const difference = meanA - meanB;

  /* ------------------------------- Welch ---------------------------------- */

  const seWelch = Math.sqrt(varA / nA + varB / nB);
  const tWelch = difference / seWelch;

  // Welch–Satterthwaite: the degrees of freedom are not an integer, and should
  // not be rounded — rounding them changes the p-value in the third decimal.
  const dfWelch =
    (varA / nA + varB / nB) ** 2 /
    ((varA / nA) ** 2 / (nA - 1) + (varB / nB) ** 2 / (nB - 1));

  const pWelch = tTwoTailed(tWelch, dfWelch);

  /* ------------------------------ Student --------------------------------- */

  const dfStudent = nA + nB - 2;
  const pooledVariance = ((nA - 1) * varA + (nB - 1) * varB) / dfStudent;
  const pooledSd = Math.sqrt(pooledVariance);
  const seStudent = pooledSd * Math.sqrt(1 / nA + 1 / nB);
  const tStudent = difference / seStudent;
  const pStudent = tTwoTailed(tStudent, dfStudent);

  /* ---------------------------- effect sizes ------------------------------ */

  /*
   * Cohen's d for two groups uses the pooled standard deviation even when the
   * Welch test is primary. The effect size answers "how far apart are these
   * groups in standard-deviation units", which is a question about the data,
   * not about which significance test was chosen.
   */
  const d = pooledSd === 0 ? Number.NaN : difference / pooledSd;
  const g = d * hedgesCorrection(dfStudent);

  /* ---------------------------- assumptions ------------------------------- */

  const normalityA = assessNormality(a, labels[0]);
  const normalityB = assessNormality(b, labels[1]);
  const homogeneity = assessHomogeneity([a, b], [labels[0], labels[1]]);

  const warnings: AnalysisWarning[] = [
    ...normalityA.warnings,
    ...normalityB.warnings,
    ...homogeneity.warnings,
    ...sizeWarnings([
      { label: labels[0], n: nA },
      { label: labels[1], n: nB },
    ]),
  ];

  /*
   * When the two forms disagree about significance, say so. It is the clearest
   * possible demonstration of why the choice of form is not a formality, and it
   * is exactly the situation in which a reader needs to know which row of the
   * SPSS output was copied.
   */
  const disagree = pWelch < 0.05 !== pStudent < 0.05;
  if (disagree) {
    warnings.push({
      code: 'welch-student-disagree',
      severity: 'warning',
      columns: [labels[0], labels[1]],
      params: {
        welchP: Number(pWelch.toPrecision(3)),
        studentP: Number(pStudent.toPrecision(3)),
      },
    });
  }

  // Unequal group sizes are when the difference between the forms bites hardest.
  const ratio = Math.max(nA, nB) / Math.min(nA, nB);
  if (ratio >= 1.5 && !homogeneity.equalVariances) {
    warnings.push({
      code: 'unequal-groups-and-variances',
      severity: 'warning',
      columns: [labels[0], labels[1]],
      params: { ratio: Number(ratio.toFixed(2)), larger: nA > nB ? labels[0] : labels[1] },
    });
  }

  const assumptions: AssumptionCheck[] = [
    normalityA.check,
    normalityB.check,
    homogeneity.check,
    independenceCheck(),
  ];

  /* Confidence interval for the difference, on the Welch standard error. */
  const criticalWelch = tQuantile(1 - (1 - level) / 2, dfWelch);

  const effect: EffectSize = { name: 'cohensD', value: d, band: bandForCohensD(d) };

  return {
    test: 't.independent',
    variables: [labels[0], labels[1]],
    statistic: { name: "t (Welch)", value: tWelch },
    df: dfWelch,
    pValue: pWelch,
    effect,
    estimates: [estimateFor(labels[0], a, level), estimateFor(labels[1], b, level)],
    assumptions,
    warnings,
    n: nA + nB,
    rowsSupplied: groupA.length + groupB.length,
    rowsDropped: dropped,
    missingPolicy: 'per-group',
    secondary: {
      label: 'student',
      statistic: { name: "t (Student)", value: tStudent },
      df: dfStudent,
      pValue: pStudent,
      effect,
    },
    detail: {
      primaryForm: 'welch',
      /*
       * Why Welch was primary, in a form the interface can turn into a sentence
       * without re-deriving the reasoning.
       */
      primaryReason: homogeneity.equalVariances
        ? 'welch-default-equal-variances'
        : 'welch-required-unequal-variances',
      studentDefensible: homogeneity.equalVariances,
      meanDifference: difference,
      standardErrorWelch: seWelch,
      standardErrorStudent: seStudent,
      pooledSd,
      hedgesG: g,
      confidenceIntervalOfDifference: {
        level,
        lower: difference - criticalWelch * seWelch,
        upper: difference + criticalWelch * seWelch,
      },
      groupSizeRatio: ratio,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              Paired t-test                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compares two measurements of the same respondents — a pre-test and a
 * post-test being the case this product will see most.
 *
 * Pairing is what makes the design powerful: each respondent is their own
 * control, so between-person variation cancels out. It is also what makes
 * listwise deletion mandatory rather than a policy choice. A respondent present
 * at pre-test and absent at post-test has no difference score at all; there is
 * nothing to include, and no amount of imputation would create one honestly.
 */
export function pairedTTest(
  before: number[],
  after: number[],
  labels: [string, string],
  options: TTestOptions = {},
): InferentialResult {
  const level = options.confidenceLevel ?? 0.95;

  if (before.length !== after.length) {
    throw new TTestError('analysis.ttest.error.unequalPairs', {
      first: before.length,
      second: after.length,
    });
  }

  const pairsA: number[] = [];
  const pairsB: number[] = [];

  for (let i = 0; i < before.length; i += 1) {
    const x = before[i] as number;
    const y = after[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pairsA.push(x);
      pairsB.push(y);
    }
  }

  const n = pairsA.length;
  const dropped = before.length - n;

  if (n < MIN_GROUP_N) {
    throw new TTestError('analysis.ttest.error.tooFewPairs', { n, minimum: MIN_GROUP_N });
  }

  const differences = pairsA.map((value, i) => value - (pairsB[i] as number));
  const meanDifference = mean(differences);
  const sdDifference = standardDeviation(differences);

  if (sdDifference === 0) {
    throw new TTestError('analysis.ttest.error.noVarianceInDifferences');
  }

  const se = sdDifference / Math.sqrt(n);
  const t = meanDifference / se;
  const df = n - 1;
  const p = tTwoTailed(t, df);

  /*
   * Cohen's d for a paired design is the mean difference over the standard
   * deviation *of the differences*, not of the raw scores. The two can be far
   * apart when the pairing is strong, and using the raw-score version — which
   * is the common mistake — understates the effect of an intervention that
   * moved everyone by a similar amount.
   */
  const d = meanDifference / sdDifference;
  const g = d * hedgesCorrection(df);

  /* Normality applies to the differences, not to either measurement. */
  const normality = assessNormality(differences, `${labels[0]} − ${labels[1]}`);

  const critical = tQuantile(1 - (1 - level) / 2, df);

  return {
    test: 't.paired',
    variables: [labels[0], labels[1]],
    statistic: { name: 't', value: t },
    df,
    pValue: p,
    effect: { name: 'cohensD', value: d, band: bandForCohensD(d) },
    estimates: [estimateFor(labels[0], pairsA, level), estimateFor(labels[1], pairsB, level)],
    assumptions: [normality.check, independenceCheck()],
    warnings: [
      ...normality.warnings,
      ...sizeWarnings([{ label: `${labels[0]} / ${labels[1]}`, n }]),
      ...(dropped > 0
        ? [
            {
              code: 'incomplete-pairs-dropped',
              severity: 'info' as const,
              columns: [labels[0], labels[1]],
              params: { dropped, supplied: before.length, used: n },
            },
          ]
        : []),
    ],
    n,
    rowsSupplied: before.length,
    rowsDropped: dropped,
    missingPolicy: 'listwise',
    detail: {
      meanDifference,
      sdOfDifferences: sdDifference,
      standardError: se,
      hedgesG: g,
      confidenceIntervalOfDifference: {
        level,
        lower: meanDifference - critical * se,
        upper: meanDifference + critical * se,
      },
      /** One-tailed p, for a directional hypothesis stated in advance. */
      oneTailedP: tSf(Math.abs(t), df),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/** Refusals carry a reason key so the message can be said in either language. */
export class TTestError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'TTestError';
  }
}
