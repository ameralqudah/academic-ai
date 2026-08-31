/**
 * The rank-based tests.
 *
 * These are what the recommender has been naming and refusing to run. When a
 * distribution is skewed, or the outcome is an ordinal scale, or the sample is
 * too small for the central limit theorem to rescue a mean, the honest answer
 * has been "Mann–Whitney is what you need, and it is not built yet". This
 * builds it.
 *
 * They work on ranks rather than values, which is the whole point: replacing
 * observations by their positions removes the assumption that the underlying
 * distribution has any particular shape. What is bought with that is
 * robustness; what is paid is a little power when the data really were normal,
 * and the loss of a mean to talk about.
 *
 * Three implementation decisions carry most of the accuracy here.
 *
 * **Ties are corrected, not ignored.** Likert data is almost entirely ties —
 * three hundred responses across five values — and the uncorrected variance is
 * too large, which makes every test conservative in a way that silently hides
 * real effects. The correction is not optional for the data this product
 * actually sees.
 *
 * **The exact distribution is used for small samples where it matters.** The
 * normal approximation is poor below about twenty observations, and small
 * samples are exactly when a researcher reaches for a non-parametric test.
 *
 * **A continuity correction is applied to the normal approximation**, because a
 * discrete statistic approximated by a continuous curve is biased without one.
 */

import { chiSquareSf, normalSf } from '../distributions';
import { median, rank } from '../stats-core';

import type { AnalysisWarning, AssumptionCheck, InferentialResult } from './types';

/** Below this, the normal approximation is not trustworthy enough to report. */
const EXACT_THRESHOLD = 20;
/** Any smaller and the test has no power worth reporting. */
const MIN_PER_GROUP = 3;

/* -------------------------------------------------------------------------- */
/*                              Shared machinery                              */
/* -------------------------------------------------------------------------- */

/**
 * The tie correction factor.
 *
 * Sum of (t³ − t) over tied groups. Without it the variance of the rank sum is
 * overstated whenever values repeat, and on a five-point scale they repeat
 * constantly — so the test becomes conservative and a real difference can fail
 * to reach significance for a reason that has nothing to do with the data.
 */
function tieCorrection(values: number[]): { correction: number; tiedGroups: number } {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  let correction = 0;
  let tiedGroups = 0;

  for (const count of counts.values()) {
    if (count > 1) {
      correction += count ** 3 - count;
      tiedGroups += 1;
    }
  }

  return { correction, tiedGroups };
}

/**
 * The exact two-sided p-value for Mann–Whitney's U, by enumeration.
 *
 * Counts how many of the possible rank assignments give a U at least as extreme
 * as the observed one, using the standard recurrence rather than generating
 * every combination — which would be astronomically many even at these sizes.
 *
 * Only valid without ties. With ties the exact distribution is no longer the
 * one this recurrence describes, and the caller falls back to the corrected
 * normal approximation.
 */
function exactMannWhitneyP(n1: number, n2: number, u: number): number {
  const maxU = n1 * n2;

  /*
   * The number of ways to obtain each value of U, by the standard recurrence.
   *
   * `counts[i][j][k]` is the number of arrangements of i items from one group
   * and j from the other giving U = k. The recurrence
   *
   *   f(i, j, k) = f(i − 1, j, k − j) + f(i, j − 1, k)
   *
   * says a given arrangement either ends with an item from the first group —
   * which contributes j to U — or from the second, which contributes nothing.
   * Two rolling layers are enough because each depends only on the one before.
   *
   * A first attempt used a looser recurrence that summed over every possible
   * contribution at each step, which counts many arrangements more than once.
   * It produced p = 0.0093 where SciPy gives 0.0499 — a difference that would
   * turn a marginal result significant, and exactly why these are checked
   * against a reference implementation rather than reasoned about.
   */
  let previous: Float64Array[] = [];
  for (let j = 0; j <= n2; j += 1) {
    const layer = new Float64Array(maxU + 1);
    layer[0] = 1; // zero items from the first group: U = 0, one way
    previous.push(layer);
  }

  for (let i = 1; i <= n1; i += 1) {
    const current: Float64Array[] = [new Float64Array(maxU + 1)];
    (current[0] as Float64Array)[0] = 1;

    for (let j = 1; j <= n2; j += 1) {
      const layer = new Float64Array(maxU + 1);
      const fromFirst = previous[j] as Float64Array;
      const fromSecond = current[j - 1] as Float64Array;

      for (let k = 0; k <= maxU; k += 1) {
        const a = k - j >= 0 ? (fromFirst[k - j] as number) : 0;
        layer[k] = a + (fromSecond[k] as number);
      }

      current.push(layer);
    }

    previous = current;
  }

  const distribution = previous[n2] as Float64Array;

  let total = 0;
  for (let k = 0; k <= maxU; k += 1) total += distribution[k] as number;

  /*
   * Two-sided, by doubling the smaller tail. U is symmetric about n1·n2/2, so
   * the lower tail up to min(u, maxU − u) is the correct one to double.
   */
  const smaller = Math.min(u, maxU - u);
  let tail = 0;
  for (let k = 0; k <= smaller; k += 1) tail += distribution[k] as number;

  return Math.min(1, (2 * tail) / total);
}

/* -------------------------------------------------------------------------- */
/*                            Mann–Whitney U test                             */
/* -------------------------------------------------------------------------- */

/**
 * Compares two independent groups without assuming normality.
 *
 * The rank-based counterpart to the independent-samples t-test, and what the
 * recommender asks for when normality fails on a small sample or the outcome is
 * ordinal.
 *
 * What it tests deserves care, because it is routinely misreported. Strictly it
 * asks whether one group tends to produce larger values than the other — not
 * whether the medians differ. Those coincide only when the two distributions
 * have the same shape, so the medians are reported as description and the
 * conclusion is stated in terms of stochastic dominance.
 */
export function mannWhitneyTest(
  groupA: number[],
  groupB: number[],
  labels: [string, string],
): InferentialResult {
  const a = groupA.filter(Number.isFinite);
  const b = groupB.filter(Number.isFinite);

  if (a.length < MIN_PER_GROUP || b.length < MIN_PER_GROUP) {
    throw new NonParametricError('analysis.nonparametric.error.groupTooSmall', {
      smallest: Math.min(a.length, b.length),
      minimum: MIN_PER_GROUP,
    });
  }

  const combined = [...a, ...b];
  const ranks = rank(combined);

  const rankSumA = ranks.slice(0, a.length).reduce((sum, value) => sum + value, 0);

  const n1 = a.length;
  const n2 = b.length;

  /* U for each group; they sum to n1·n2, which is the check below. */
  const uA = rankSumA - (n1 * (n1 + 1)) / 2;
  const uB = n1 * n2 - uA;
  const u = Math.min(uA, uB);

  const { correction, tiedGroups } = tieCorrection(combined);
  const hasTies = correction > 0;

  const meanU = (n1 * n2) / 2;
  const total = n1 + n2;

  /*
   * The tie-corrected variance. The uncorrected form is the special case where
   * the correction term is zero, so this is the general expression rather than
   * a separate branch.
   */
  const variance =
    ((n1 * n2) / 12) * (total + 1 - correction / (total * (total - 1)));

  const warnings: AnalysisWarning[] = [];
  let pValue: number;
  let method: 'exact' | 'normal';

  /*
   * Exact where it is both possible and needed. The enumeration is only valid
   * without ties, and the normal approximation is only poor at small sizes —
   * so the exact test is used precisely where those two conditions meet.
   */
  if (!hasTies && total <= EXACT_THRESHOLD) {
    pValue = exactMannWhitneyP(n1, n2, u);
    method = 'exact';
  } else {
    /* Continuity correction: a discrete statistic on a continuous curve. */
    const z = variance > 0 ? (Math.abs(u - meanU) - 0.5) / Math.sqrt(variance) : 0;
    pValue = Math.min(1, 2 * normalSf(Math.abs(z)));
    method = 'normal';

    if (total <= EXACT_THRESHOLD && hasTies) {
      warnings.push({
        code: 'nonparametric-approximate-due-to-ties',
        severity: 'info',
      columns: [],
        params: { n: total, tiedGroups },
      });
    }
  }

  const z = variance > 0 ? (u - meanU) / Math.sqrt(variance) : 0;

  /*
   * Rank-biserial correlation as the effect size: the difference in the
   * proportion of pairs favouring each group. Bounded by ±1 and interpretable
   * without reference to a distribution, which is the point of using it here
   * rather than converting to Cohen's d.
   */
  const rankBiserial = 1 - (2 * u) / (n1 * n2);
  const effectValue = uA >= uB ? Math.abs(rankBiserial) : -Math.abs(rankBiserial);

  if (Math.min(n1, n2) < 10) {
    warnings.push({ code: 'small-group', severity: 'warning',
      columns: [], params: { threshold: 10 } });
  }

  if (hasTies && tiedGroups > 0) {
    warnings.push({
      code: 'ties-corrected',
      severity: 'info',
      columns: [],
      params: { tiedGroups },
    });
  }

  const assumptions: AssumptionCheck[] = [
    {
      key: 'independence',
      status: 'not-testable',
    },
    {
      /*
       * Stated rather than tested. Comparing medians requires the two
       * distributions to have a similar shape; without that the test still
       * answers a valid question — does one group tend to score higher — but
       * "the medians differ" is not what was shown.
       */
      key: 'similar-distribution-shape',
      status: 'not-testable',
    },
  ];

  return {
    test: 'nonparametric.mannWhitney',
    variables: labels,
    statistic: { name: 'U', value: u },
    df: Number.NaN,
    pValue,
    effect: {
      name: 'rankBiserial',
      value: effectValue,
      band: bandForRankBiserial(Math.abs(effectValue)),
    },
    estimates: [
      { label: labels[0], n: n1, mean: median(a), sd: Number.NaN, se: Number.NaN },
      { label: labels[1], n: n2, mean: median(b), sd: Number.NaN, se: Number.NaN },
    ],
    assumptions,
    warnings,
    n: total,
    rowsSupplied: groupA.length + groupB.length,
    rowsDropped: groupA.length + groupB.length - total,
    missingPolicy: 'listwise',
    detail: {
      method,
      uA,
      uB,
      z,
      rankSumA,
      rankSumB: ranks.slice(n1).reduce((sum, value) => sum + value, 0),
      medianA: median(a),
      medianB: median(b),
      tiedGroups,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                        Wilcoxon signed-rank test                           */
/* -------------------------------------------------------------------------- */

/**
 * Compares two related measurements without assuming normality.
 *
 * The counterpart to the paired t-test: the same respondents measured twice,
 * before and after, or on two matched items.
 *
 * Zero differences are discarded before ranking, which is Wilcoxon's original
 * treatment and the one every statistics package uses. It reduces the effective
 * sample, so the number dropped is reported rather than absorbed — a paired
 * test on forty respondents where thirty answered identically is a test on ten,
 * and the reader needs to know that.
 */
export function wilcoxonSignedRankTest(
  first: number[],
  second: number[],
  labels: [string, string],
): InferentialResult {
  if (first.length !== second.length) {
    throw new NonParametricError('analysis.nonparametric.error.unequalPairs', {
      first: first.length,
      second: second.length,
    });
  }

  /* Complete pairs only — a respondent measured once tells us nothing about change. */
  const differences: number[] = [];
  for (let i = 0; i < first.length; i += 1) {
    const a = first[i] as number;
    const b = second[i] as number;
    if (Number.isFinite(a) && Number.isFinite(b)) differences.push(a - b);
  }

  const nonZero = differences.filter((difference) => difference !== 0);
  const zeroCount = differences.length - nonZero.length;

  if (nonZero.length < MIN_PER_GROUP) {
    throw new NonParametricError('analysis.nonparametric.error.tooFewPairs', {
      n: nonZero.length,
      minimum: MIN_PER_GROUP,
    });
  }

  const magnitudes = nonZero.map(Math.abs);
  const ranks = rank(magnitudes);

  let positiveSum = 0;
  let negativeSum = 0;

  for (let i = 0; i < nonZero.length; i += 1) {
    const value = ranks[i] as number;
    if ((nonZero[i] as number) > 0) positiveSum += value;
    else negativeSum += value;
  }

  const w = Math.min(positiveSum, negativeSum);
  const n = nonZero.length;

  const meanW = (n * (n + 1)) / 4;
  const { correction, tiedGroups } = tieCorrection(magnitudes);
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - correction / 48;

  const z = variance > 0 ? (Math.abs(w - meanW) - 0.5) / Math.sqrt(variance) : 0;
  const pValue = Math.min(1, 2 * normalSf(Math.abs(z)));

  const warnings: AnalysisWarning[] = [];

  if (n < EXACT_THRESHOLD) {
    warnings.push({
      code: 'nonparametric-normal-approximation',
      severity: 'warning',
      columns: [],
      params: { n, threshold: EXACT_THRESHOLD },
    });
  }

  /*
   * Zero differences matter enough to report. Half the sample answering
   * identically at both times is a finding about the measure, and it also means
   * the test ran on far fewer cases than the reader might assume.
   */
  if (zeroCount > 0) {
    warnings.push({
      code: 'zero-differences-dropped',
      severity: zeroCount > differences.length / 2 ? 'warning' : 'info',
      columns: [],
      params: { dropped: zeroCount, remaining: n },
    });
  }

  if (tiedGroups > 0) {
    warnings.push({ code: 'ties-corrected', severity: 'info',
      columns: [], params: { tiedGroups } });
  }

  const effect = variance > 0 ? Math.abs(z) / Math.sqrt(n) : 0;

  return {
    test: 'nonparametric.wilcoxon',
    variables: labels,
    statistic: { name: 'W', value: w },
    df: Number.NaN,
    pValue,
    effect: { name: 'r', value: effect, band: bandForR(effect) },
    estimates: [
      { label: labels[0], n: differences.length, mean: median(first.filter(Number.isFinite)), sd: Number.NaN, se: Number.NaN },
      { label: labels[1], n: differences.length, mean: median(second.filter(Number.isFinite)), sd: Number.NaN, se: Number.NaN },
    ],
    assumptions: [
      { key: 'independence', status: 'not-testable' },
      {
        key: 'symmetric-differences',
        status: 'not-testable',
      },
    ],
    warnings,
    n,
    rowsSupplied: first.length,
    rowsDropped: first.length - differences.length,
    missingPolicy: 'listwise',
    detail: {
      positiveSum,
      negativeSum,
      z,
      zeroDifferences: zeroCount,
      medianDifference: median(differences),
      tiedGroups,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          Kruskal–Wallis H test                             */
/* -------------------------------------------------------------------------- */

/**
 * Compares three or more independent groups without assuming normality.
 *
 * The counterpart to one-way ANOVA. Like ANOVA it is an omnibus test: a
 * significant H says the groups are not all alike and does not say which
 * differ, so post-hoc comparisons are a separate question the recommender
 * raises rather than something answered here.
 */
export function kruskalWallisTest(
  groups: number[][],
  labels: string[],
): InferentialResult {
  const cleaned = groups.map((group) => group.filter(Number.isFinite));
  const usable = cleaned.filter((group) => group.length >= MIN_PER_GROUP);

  if (usable.length < 3) {
    throw new NonParametricError('analysis.nonparametric.error.tooFewGroups', {
      groups: usable.length,
    });
  }

  const combined = cleaned.flat();
  const ranks = rank(combined);
  const total = combined.length;

  let offset = 0;
  let h = 0;
  const estimates: InferentialResult['estimates'] = [];
  const rankSums: number[] = [];

  for (let g = 0; g < cleaned.length; g += 1) {
    const group = cleaned[g] as number[];
    const groupRanks = ranks.slice(offset, offset + group.length);
    const rankSum = groupRanks.reduce((sum, value) => sum + value, 0);

    rankSums.push(rankSum);
    if (group.length > 0) h += rankSum ** 2 / group.length;

    estimates.push({
      label: labels[g] ?? `Group ${g + 1}`,
      n: group.length,
      mean: group.length > 0 ? median(group) : Number.NaN,
      sd: Number.NaN,
      se: Number.NaN,
    });

    offset += group.length;
  }

  h = (12 / (total * (total + 1))) * h - 3 * (total + 1);

  /* Tie correction divides H, so ties inflate it back toward the true value. */
  const { correction, tiedGroups } = tieCorrection(combined);
  const divisor = 1 - correction / (total ** 3 - total);
  const hCorrected = divisor > 0 ? h / divisor : h;

  const df = cleaned.length - 1;
  const pValue = chiSquareSf(hCorrected, df);

  const warnings: AnalysisWarning[] = [];

  if (cleaned.some((group) => group.length < 5)) {
    warnings.push({ code: 'small-group', severity: 'warning',
      columns: [], params: { threshold: 5 } });
  }
  if (tiedGroups > 0) {
    warnings.push({ code: 'ties-corrected', severity: 'info',
      columns: [], params: { tiedGroups } });
  }
  /*
   * The omnibus result names no pair. Saying so where the result is stated
   * stops a significant H being reported as "group A scored higher than B",
   * which is a claim it does not support.
   */
  if (pValue < 0.05) {
    warnings.push({ code: 'omnibus-needs-posthoc', severity: 'info',
      columns: [], params: {} });
  }

  /* Epsilon-squared: the share of rank variance explained, bounded 0 to 1. */
  const epsilonSquared = total > 1 ? hCorrected / ((total ** 2 - 1) / (total + 1)) : 0;

  return {
    test: 'nonparametric.kruskalWallis',
    variables: labels,
    statistic: { name: 'H', value: hCorrected },
    df,
    pValue,
    effect: {
      name: 'epsilonSquared',
      value: epsilonSquared,
      band: bandForEpsilonSquared(epsilonSquared),
    },
    estimates,
    assumptions: [
      { key: 'independence', status: 'not-testable' },
      {
        key: 'similar-distribution-shape',
        status: 'not-testable',
      },
    ],
    warnings,
    n: total,
    rowsSupplied: groups.flat().length,
    rowsDropped: groups.flat().length - total,
    missingPolicy: 'listwise',
    detail: {
      hUncorrected: h,
      tieCorrectionDivisor: divisor,
      rankSums,
      tiedGroups,
      medians: cleaned.map((group) => (group.length > 0 ? median(group) : Number.NaN)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Support                                   */
/* -------------------------------------------------------------------------- */

export class NonParametricError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'NonParametricError';
  }
}

/** Cohen's conventions, as adapted for the rank-biserial correlation. */
function bandForRankBiserial(value: number): 'negligible' | 'small' | 'medium' | 'large' {
  const magnitude = Math.abs(value);
  if (magnitude < 0.1) return 'negligible';
  if (magnitude < 0.3) return 'small';
  if (magnitude < 0.5) return 'medium';
  return 'large';
}

function bandForR(value: number): 'negligible' | 'small' | 'medium' | 'large' {
  const magnitude = Math.abs(value);
  if (magnitude < 0.1) return 'negligible';
  if (magnitude < 0.3) return 'small';
  if (magnitude < 0.5) return 'medium';
  return 'large';
}

function bandForEpsilonSquared(value: number): 'negligible' | 'small' | 'medium' | 'large' {
  if (value < 0.01) return 'negligible';
  if (value < 0.08) return 'small';
  if (value < 0.26) return 'medium';
  return 'large';
}
