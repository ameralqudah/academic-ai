/**
 * Assumption checks — the tests that decide which test is correct.
 *
 * These run before the analysis the researcher asked for, and their answers
 * change what that analysis should be. A two-group comparison is a Student's t
 * when the variances are homogeneous and a Welch's t when they are not; it is a
 * Mann–Whitney when the distributions are far enough from normal and the sample
 * is small enough for that to matter. Getting this stage wrong does not produce
 * a slightly-off p-value, it produces the wrong test entirely.
 *
 * The results are structured, not prose: a status, a statistic, a p-value, and
 * — when an assumption fails — the name of the test to use instead. That last
 * field is what lets the caller route around a violation without needing to
 * know any statistics itself.
 *
 * One caution belongs in the code rather than the documentation, because it is
 * a real limitation of the method. **Normality tests are sensitive to sample
 * size in a way that inverts their usefulness.** With thirty respondents almost
 * nothing is rejected; with a thousand, a distribution visually indistinguish-
 * able from normal is rejected on a trivial deviation. A significant result on
 * a large sample is therefore not licence to abandon a parametric test — the
 * central limit theorem has already done its work, and the mean is fine. The
 * assessment functions below encode that, because the alternative is a student
 * running non-parametric tests on eight hundred cases for no reason.
 */

import { fSf, normalCdf, normalQuantile } from '../distributions';
import { mean, median } from '../stats-core';
import type { AnalysisWarning, AssumptionCheck } from './types';

/* -------------------------------------------------------------------------- */
/*                        Shapiro–Wilk normality test                         */
/* -------------------------------------------------------------------------- */

/**
 * Supported sample sizes, which are hard constraints of the method rather than
 * choices.
 *
 * Below 3 the test is undefined: two points are always perfectly "normal".
 * Above 5000 Royston's fitted polynomials are outside their validated range,
 * and at that size the test is answering a question nobody should be asking
 * (see the note on sample-size sensitivity above).
 */
export const SHAPIRO_WILK_MIN_N = 3;
export const SHAPIRO_WILK_MAX_N = 5000;

/**
 * Shapiro–Wilk W, by Royston's algorithm.
 *
 * Source: P. Royston (1995), "Remark AS R94: A Remark on Algorithm AS 181: The
 * W Test for Normality", *Journal of the Royal Statistical Society Series C
 * (Applied Statistics)* 44(4), 547–551. This is the algorithm behind R's
 * `shapiro.test` and SciPy's `shapiro`, which is deliberate: a student checking
 * this product's output against either must get the same number.
 *
 * The coefficient vectors below are Royston's, transcribed from the published
 * algorithm. They are constants of the method, not tuning parameters — nothing
 * here should ever be adjusted to make a result come out differently.
 */

/** Corrections to the two largest coefficients of the m-vector. */
const C1 = [0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056];
const C2 = [0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633];
/** Small-sample branch (4 ≤ n ≤ 11): μ, log σ, and the γ shift, in n. */
const C3 = [0.544, -0.39978, 0.025054, -0.0006714];
const C4 = [1.3822, -0.77857, 0.062767, -0.0020322];
const GAMMA = [-2.273, 0.459];
/** Large-sample branch (n ≥ 12): μ and log σ, in log(n). */
const C5 = [-1.5861, -0.31082, -0.083751, 0.0038915];
const C6 = [-0.4803, -0.082676, 0.0030302];

/** Horner evaluation; coefficients are given lowest-order first. */
function polynomial(coefficients: number[], x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i -= 1) {
    result = result * x + (coefficients[i] as number);
  }
  return result;
}

export interface ShapiroWilkResult {
  w: number;
  pValue: number;
  n: number;
}

/**
 * Returns null — rather than a number that would not mean anything — when the
 * sample is outside the supported range or has no variance at all.
 */
export function shapiroWilk(values: number[]): ShapiroWilkResult | null {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  if (n < SHAPIRO_WILK_MIN_N || n > SHAPIRO_WILK_MAX_N) return null;
  if ((sorted[n - 1] as number) - (sorted[0] as number) === 0) return null;

  /* ------------- expected normal order statistics (Blom's estimate) ------- */

  const m = new Array<number>(n).fill(0);
  let ssumm2 = 0;

  for (let i = 0; i < n; i += 1) {
    const value = normalQuantile((i + 1 - 0.375) / (n + 0.25));
    m[i] = value;
    ssumm2 += value * value;
  }

  /* ------------------- the a-vector, with Royston's corrections ----------- */

  const a = new Array<number>(n).fill(0);
  const rsn = 1 / Math.sqrt(n);

  if (n === 3) {
    a[0] = -Math.SQRT1_2;
    a[1] = 0;
    a[2] = Math.SQRT1_2;
  } else {
    const summ2 = Math.sqrt(ssumm2);
    const a1 = -(m[0] as number) / summ2 + polynomial(C1, rsn);
    let start: number;
    let fac: number;

    if (n > 5) {
      const a2 = -(m[1] as number) / summ2 + polynomial(C2, rsn);
      fac =
        (ssumm2 - 2 * (m[0] as number) ** 2 - 2 * (m[1] as number) ** 2) /
        (1 - 2 * a1 * a1 - 2 * a2 * a2);
      start = 2;
      a[0] = -a1;
      a[1] = -a2;
      a[n - 1] = a1;
      a[n - 2] = a2;
    } else {
      fac = (ssumm2 - 2 * (m[0] as number) ** 2) / (1 - 2 * a1 * a1);
      start = 1;
      a[0] = -a1;
      a[n - 1] = a1;
    }

    const rootFac = Math.sqrt(fac);
    for (let i = start; i < n - start; i += 1) {
      a[i] = (m[i] as number) / rootFac;
    }
  }

  /* ------------------------------ the statistic --------------------------- */

  const average = mean(sorted);
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i += 1) {
    numerator += (a[i] as number) * (sorted[i] as number);
    denominator += ((sorted[i] as number) - average) ** 2;
  }

  if (denominator === 0) return null;

  const w = Math.min(1, (numerator * numerator) / denominator);

  /* ---------------------------- the significance -------------------------- */

  let pValue: number;

  if (n === 3) {
    // Exact: for three points the null distribution of W is known in closed form.
    const pi6 = 1.909859317102744;
    const stqr = 1.047197551196598;
    pValue = pi6 * (Math.asin(Math.sqrt(w)) - stqr);
  } else {
    let y = Math.log(1 - w);
    let mu: number;
    let sigma: number;

    if (n <= 11) {
      const gamma = polynomial(GAMMA, n);
      if (y >= gamma) return { w, pValue: 1e-99, n };
      y = -Math.log(gamma - y);
      mu = polynomial(C3, n);
      sigma = Math.exp(polynomial(C4, n));
    } else {
      const logN = Math.log(n);
      mu = polynomial(C5, logN);
      sigma = Math.exp(polynomial(C6, logN));
    }

    // Upper tail: small W means far from normal, which is the significant end.
    pValue = 1 - normalCdf((y - mu) / sigma);
  }

  return { w, pValue: Math.min(1, Math.max(0, pValue)), n };
}

/* -------------------------------------------------------------------------- */
/*                          Levene's test for variance                        */
/* -------------------------------------------------------------------------- */

export type LeveneCenter = 'median' | 'mean';

export interface LeveneResult {
  statistic: number;
  df: [number, number];
  pValue: number;
  center: LeveneCenter;
  groupCount: number;
  n: number;
}

/**
 * Levene's test, centred on the median by default — the Brown–Forsythe variant.
 *
 * The original test centres on the group means, which makes it sensitive to
 * departures from normality: a skewed distribution gets flagged as
 * heteroscedastic when the real problem is its shape. Centring on the median
 * costs little power under normality and is far more robust without it. Since
 * the entire purpose of this function is to be trusted on data whose normality
 * is in question, the robust version is the default.
 */
export function levene(groups: number[][], center: LeveneCenter = 'median'): LeveneResult | null {
  const usable = groups.filter((group) => group.length >= 2);
  const k = usable.length;
  if (k < 2) return null;

  const n = usable.reduce((total, group) => total + group.length, 0);
  if (n - k < 1) return null;

  const deviations = usable.map((group) => {
    const centre = center === 'median' ? median(group) : mean(group);
    return group.map((value) => Math.abs(value - centre));
  });

  const groupMeans = deviations.map((group) => mean(group));
  const grandMean = mean(deviations.flat());

  let between = 0;
  let within = 0;

  for (let i = 0; i < k; i += 1) {
    const group = deviations[i] as number[];
    const groupMean = groupMeans[i] as number;
    between += group.length * (groupMean - grandMean) ** 2;
    for (const value of group) within += (value - groupMean) ** 2;
  }

  if (within === 0) return null;

  const statistic = ((n - k) / (k - 1)) * (between / within);
  const df: [number, number] = [k - 1, n - k];

  return { statistic, df, pValue: fSf(statistic, df[0], df[1]), center, groupCount: k, n };
}

/* -------------------------------------------------------------------------- */
/*                       Turning results into decisions                       */
/* -------------------------------------------------------------------------- */

/** The conventional α for assumption checks — deliberately not the study's α. */
const ASSUMPTION_ALPHA = 0.05;

/**
 * Sample size above which a significant normality test stops being a reason to
 * abandon a parametric test.
 *
 * At this size the sampling distribution of the mean is approximately normal
 * whatever the shape of the data, so a t-test is robust; meanwhile the
 * normality test has become powerful enough to reject on deviations too small
 * to matter. Reporting the rejection without this context is what sends
 * students to non-parametric tests they do not need.
 */
const CENTRAL_LIMIT_N = 30;

export interface NormalityAssessment {
  check: AssumptionCheck;
  warnings: AnalysisWarning[];
  result: ShapiroWilkResult | null;
  /** Whether a parametric test remains defensible, which is not the same as "normal". */
  parametricDefensible: boolean;
}

/**
 * Runs Shapiro–Wilk and turns it into a decision the rest of the system can act
 * on. `label` names what was tested — a variable, or one group within it — so
 * the message can say which part of the data failed rather than "the data".
 */
export function assessNormality(values: number[], label: string): NormalityAssessment {
  const warnings: AnalysisWarning[] = [];
  const result = shapiroWilk(values);

  if (!result) {
    const code =
      values.length < SHAPIRO_WILK_MIN_N
        ? 'normality-sample-too-small'
        : values.length > SHAPIRO_WILK_MAX_N
          ? 'normality-sample-too-large'
          : 'normality-no-variance';

    warnings.push({ code, severity: 'info', columns: [label], params: { n: values.length } });

    return {
      check: {
        key: 'normality',
        status: 'inconclusive',
        via: 'normality.shapiroWilk',
        detail: { label, n: values.length },
      },
      warnings,
      result: null,
      // A large sample is the reason the test could not run; that is not a problem.
      parametricDefensible: values.length >= CENTRAL_LIMIT_N,
    };
  }

  const normal = result.pValue >= ASSUMPTION_ALPHA;
  const largeSample = result.n >= CENTRAL_LIMIT_N;

  if (!normal && largeSample) {
    /*
     * Significant, but the sample is large enough that switching tests is not
     * warranted. Severity is 'info' rather than 'warning' precisely because the
     * intended action is to carry on.
     */
    warnings.push({
      code: 'normality-violated-but-large-sample',
      severity: 'info',
      columns: [label],
      params: {
        n: result.n,
        w: Number(result.w.toFixed(4)),
        p: Number(result.pValue.toPrecision(3)),
        threshold: CENTRAL_LIMIT_N,
      },
    });
  } else if (!normal) {
    warnings.push({
      code: 'normality-violated',
      severity: 'warning',
      columns: [label],
      params: { n: result.n, w: Number(result.w.toFixed(4)), p: Number(result.pValue.toPrecision(3)) },
    });
  }

  return {
    check: {
      key: 'normality',
      status: normal ? 'met' : 'violated',
      via: 'normality.shapiroWilk',
      statistic: result.w,
      pValue: result.pValue,
      alternative: normal || largeSample ? undefined : 'nonparametric.mannWhitney',
      detail: { label, n: result.n },
    },
    warnings,
    result,
    parametricDefensible: normal || largeSample,
  };
}

export interface HomogeneityAssessment {
  check: AssumptionCheck;
  warnings: AnalysisWarning[];
  result: LeveneResult | null;
  /**
   * Whether the equal-variance form of a test is defensible.
   *
   * Note what this does *not* decide. This product reports Welch as the primary
   * result either way: Welch loses almost nothing when variances are equal and
   * is substantially safer when they are not, and unequal group sizes — the
   * ordinary situation in survey research — are exactly when the difference
   * bites. This flag decides whether Student's t is worth showing alongside,
   * and what the interface says about why.
   */
  equalVariances: boolean;
}

export function assessHomogeneity(
  groups: number[][],
  labels: string[],
  center: LeveneCenter = 'median',
): HomogeneityAssessment {
  const warnings: AnalysisWarning[] = [];
  const result = levene(groups, center);

  if (!result) {
    warnings.push({
      code: 'homogeneity-not-testable',
      severity: 'info',
      columns: labels,
      params: { groups: groups.length },
    });

    return {
      check: { key: 'homogeneity-of-variance', status: 'inconclusive', via: 'homogeneity.levene' },
      warnings,
      result: null,
      equalVariances: false,
    };
  }

  const equal = result.pValue >= ASSUMPTION_ALPHA;

  if (!equal) {
    warnings.push({
      code: 'homogeneity-violated',
      severity: 'info',
      columns: labels,
      params: {
        statistic: Number(result.statistic.toFixed(4)),
        p: Number(result.pValue.toPrecision(3)),
      },
    });
  }

  return {
    check: {
      key: 'homogeneity-of-variance',
      status: equal ? 'met' : 'violated',
      via: 'homogeneity.levene',
      statistic: result.statistic,
      pValue: result.pValue,
      detail: { center, groups: result.groupCount, n: result.n },
    },
    warnings,
    result,
    equalVariances: equal,
  };
}

/**
 * Independence of observations: declared, never tested.
 *
 * Every test in this module assumes each row is one respondent who did not
 * influence any other. Whether that holds is a fact about how the data were
 * collected — students in one classroom answering together, a survey link
 * shared within a family, repeated measures entered as separate rows — and no
 * arithmetic can recover it after the fact. Returned as an explicit
 * `not-testable` check rather than omitted, because omitting it reads to a
 * researcher as "checked, and fine".
 */
export function independenceCheck(): AssumptionCheck {
  return { key: 'independence', status: 'not-testable' };
}
