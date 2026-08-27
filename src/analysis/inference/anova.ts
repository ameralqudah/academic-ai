/**
 * One-way analysis of variance, and what has to come after it.
 *
 * ANOVA answers one question — "are these k means all equal?" — and it answers
 * it with a single yes or no. That is almost never the question the researcher
 * actually has. Told that four teaching methods differ, nobody stops there;
 * they want to know which method beat which. So this module treats the omnibus
 * test and the pairwise comparisons as one procedure rather than two, because
 * separating them is how the most common error in applied statistics happens.
 *
 * **Why not just run t-tests on every pair.** With four groups there are six
 * pairs; with five, ten. Each t-test carries its own 5% chance of a false
 * positive, and those chances accumulate: across ten comparisons the
 * probability of at least one spurious "significant" result is about 40%. A
 * researcher who runs all the pairs and reports the two that came out
 * significant has not found two effects, they have found the two places where
 * noise happened to pile up. Tukey's HSD compares each difference against the
 * distribution of the *largest* difference among k means, which holds the error
 * rate for the whole family at 5% instead of for each test separately.
 *
 * **Two omnibus forms, as with the t-test.** Classical ANOVA assumes equal
 * variances across groups. When that fails — and with unequal group sizes it
 * fails consequentially — Welch's ANOVA is the correct form, for the same
 * reasons Welch's t is preferred over Student's. Both are computed; the one
 * that matches the data is primary, and the other is reported beside it.
 *
 * **Two effect sizes, because η² is biased.** η² is the proportion of variance
 * explained *in this sample*, and it overstates the population value — badly
 * when groups are small. ω² corrects for that. Both are reported: η² because it
 * is what the literature prints, ω² because it is the honest number.
 */

import { fSf, studentizedRangeQuantile, studentizedRangeSf } from '../distributions';
import { mean, standardDeviation, variance } from '../stats-core';
import { assessHomogeneity, assessNormality, independenceCheck } from './assumptions';
import {
  bandForEtaSquared,
  type AnalysisWarning,
  type AssumptionCheck,
  type GroupEstimate,
  type InferentialResult,
} from './types';

const MIN_GROUP_N = 2;
const SMALL_GROUP_N = 15;

export interface AnovaOptions {
  confidenceLevel?: number;
  /** Run Tukey's HSD regardless of the omnibus result. Off by default; see below. */
  forcePostHoc?: boolean;
}

export interface TukeyComparison {
  groupA: string;
  groupB: string;
  meanDifference: number;
  standardError: number;
  q: number;
  pValue: number;
  confidenceInterval: { level: number; lower: number; upper: number };
  significant: boolean;
}

export class AnovaError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'AnovaError';
  }
}

/* -------------------------------------------------------------------------- */
/*                              One-way ANOVA                                 */
/* -------------------------------------------------------------------------- */

export function oneWayAnova(
  groups: number[][],
  labels: string[],
  options: AnovaOptions = {},
): InferentialResult {
  const level = options.confidenceLevel ?? 0.95;

  if (groups.length !== labels.length) {
    throw new AnovaError('analysis.anova.error.labelMismatch', {
      groups: groups.length,
      labels: labels.length,
    });
  }

  const clean = groups.map((group) => group.filter((value) => Number.isFinite(value)));
  const suppliedRows = groups.reduce((total, group) => total + group.length, 0);
  const usedRows = clean.reduce((total, group) => total + group.length, 0);

  const keptIndices = clean
    .map((group, index) => ({ group, index }))
    .filter((entry) => entry.group.length >= MIN_GROUP_N)
    .map((entry) => entry.index);

  const k = keptIndices.length;

  if (k < 2) {
    throw new AnovaError('analysis.anova.error.tooFewGroups', { groups: k });
  }

  const usable = keptIndices.map((index) => clean[index] as number[]);
  const usableLabels = keptIndices.map((index) => labels[index] as string);

  const n = usable.reduce((total, group) => total + group.length, 0);
  if (n - k < 1) {
    throw new AnovaError('analysis.anova.error.tooFewObservations', { n, groups: k });
  }

  const groupMeans = usable.map((group) => mean(group));
  const groupVariances = usable.map((group) => variance(group));
  const grandMean = usable.flat().reduce((sum, value) => sum + value, 0) / n;

  /* ------------------------------ sums of squares ------------------------- */

  let ssBetween = 0;
  let ssWithin = 0;

  for (let i = 0; i < k; i += 1) {
    const group = usable[i] as number[];
    const groupMean = groupMeans[i] as number;
    ssBetween += group.length * (groupMean - grandMean) ** 2;
    for (const value of group) ssWithin += (value - groupMean) ** 2;
  }

  const ssTotal = ssBetween + ssWithin;

  if (ssTotal === 0) {
    throw new AnovaError('analysis.anova.error.noVariance');
  }

  const dfBetween = k - 1;
  const dfWithin = n - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;

  if (msWithin === 0) {
    throw new AnovaError('analysis.anova.error.noWithinVariance');
  }

  const f = msBetween / msWithin;
  const p = fSf(f, dfBetween, dfWithin);

  /* -------------------------------- effect sizes -------------------------- */

  const etaSquared = ssBetween / ssTotal;

  /*
   * ω² can come out negative when the observed effect is smaller than what
   * sampling noise alone would produce. That is not a computational error — it
   * is the estimator honestly reporting "no detectable effect" — but a negative
   * proportion of variance makes no sense to report, so it is floored at zero
   * and the fact is left visible in the detail block.
   */
  const omegaRaw = (ssBetween - dfBetween * msWithin) / (ssTotal + msWithin);
  const omegaSquared = Math.max(0, omegaRaw);

  /* ------------------------------ Welch's ANOVA --------------------------- */

  const welch = welchAnova(usable, groupMeans, groupVariances);

  /* -------------------------------- assumptions --------------------------- */

  const normalities = usable.map((group, i) => assessNormality(group, usableLabels[i] as string));
  const homogeneity = assessHomogeneity(usable, usableLabels);

  const assumptions: AssumptionCheck[] = [
    ...normalities.map((assessment) => assessment.check),
    homogeneity.check,
    independenceCheck(),
  ];

  const warnings: AnalysisWarning[] = [
    ...normalities.flatMap((assessment) => assessment.warnings),
    ...homogeneity.warnings,
  ];

  const smallGroups = usable
    .map((group, i) => ({ label: usableLabels[i] as string, n: group.length }))
    .filter((entry) => entry.n < SMALL_GROUP_N);

  if (smallGroups.length > 0) {
    warnings.push({
      code: 'small-group',
      severity: 'warning',
      columns: smallGroups.map((entry) => entry.label),
      params: { threshold: SMALL_GROUP_N, smallest: Math.min(...smallGroups.map((e) => e.n)) },
    });
  }

  if (keptIndices.length < groups.length) {
    const dropped = labels.filter((_, index) => !keptIndices.includes(index));
    warnings.push({
      code: 'group-dropped-too-small',
      severity: 'warning',
      columns: dropped,
      params: { dropped: dropped.length, minimum: MIN_GROUP_N },
    });
  }

  /*
   * Group sizes that differ by more than half again are where the equal-variance
   * assumption stops being a technicality: the classical F becomes liberal when
   * the smaller group has the larger variance, and conservative when it does not.
   */
  const sizes = usable.map((group) => group.length);
  const sizeRatio = Math.max(...sizes) / Math.min(...sizes);
  if (sizeRatio >= 1.5 && !homogeneity.equalVariances) {
    warnings.push({
      code: 'unequal-groups-and-variances',
      severity: 'warning',
      columns: usableLabels,
      params: { ratio: Number(sizeRatio.toFixed(2)) },
    });
  }

  const primaryIsWelch = !homogeneity.equalVariances && welch !== null;

  if (primaryIsWelch && welch) {
    const disagree = p < 0.05 !== welch.pValue < 0.05;
    if (disagree) {
      warnings.push({
        code: 'welch-classical-disagree',
        severity: 'warning',
        columns: usableLabels,
        params: {
          classicalP: Number(p.toPrecision(3)),
          welchP: Number(welch.pValue.toPrecision(3)),
        },
      });
    }
  }

  /* --------------------------------- post hoc ----------------------------- */

  /*
   * Tukey runs only when the omnibus test found something, which is the
   * conventional protection: pairwise comparisons after a non-significant F are
   * fishing. `forcePostHoc` exists because that convention has legitimate
   * exceptions — a planned comparison stated before the data were seen — but it
   * has to be asked for deliberately.
   */
  const omnibusP = primaryIsWelch && welch ? welch.pValue : p;
  const runPostHoc = options.forcePostHoc === true || omnibusP < 0.05;

  const comparisons = runPostHoc
    ? tukeyHsd(usable, usableLabels, groupMeans, msWithin, dfWithin, level)
    : [];

  if (runPostHoc && !homogeneity.equalVariances) {
    /*
     * Tukey itself assumes equal variances. With them violated it is no longer
     * exact, and Games–Howell is the right procedure. That is not implemented
     * yet, so the comparisons are reported with an explicit caveat rather than
     * withheld — a caveated number the researcher can weigh beats a blank.
     */
    warnings.push({
      code: 'tukey-assumes-equal-variances',
      severity: 'warning',
      columns: usableLabels,
      params: { alternative: 'games-howell' },
    });
  }

  const estimates: GroupEstimate[] = usable.map((group, i) => {
    const groupN = group.length;
    const sd = standardDeviation(group);
    return {
      label: usableLabels[i] as string,
      n: groupN,
      mean: groupMeans[i] as number,
      sd,
      se: sd / Math.sqrt(groupN),
    };
  });

  return {
    test: 'anova.oneWay',
    variables: usableLabels,
    statistic: {
      name: primaryIsWelch ? 'F (Welch)' : 'F',
      value: primaryIsWelch && welch ? welch.f : f,
    },
    df: primaryIsWelch && welch ? welch.df : [dfBetween, dfWithin],
    pValue: omnibusP,
    effect: { name: 'etaSquared', value: etaSquared, band: bandForEtaSquared(etaSquared) },
    estimates,
    assumptions,
    warnings,
    n,
    rowsSupplied: suppliedRows,
    rowsDropped: suppliedRows - usedRows,
    missingPolicy: 'per-group',
    secondary:
      welch === null
        ? undefined
        : primaryIsWelch
          ? {
              label: 'classical',
              statistic: { name: 'F', value: f },
              df: [dfBetween, dfWithin],
              pValue: p,
              effect: { name: 'etaSquared', value: etaSquared, band: bandForEtaSquared(etaSquared) },
            }
          : {
              label: 'welch',
              statistic: { name: 'F (Welch)', value: welch.f },
              df: welch.df,
              pValue: welch.pValue,
              effect: { name: 'etaSquared', value: etaSquared, band: bandForEtaSquared(etaSquared) },
            },
    detail: {
      primaryForm: primaryIsWelch ? 'welch' : 'classical',
      primaryReason: primaryIsWelch
        ? 'welch-required-unequal-variances'
        : 'classical-equal-variances',
      ssBetween,
      ssWithin,
      ssTotal,
      dfBetween,
      dfWithin,
      msBetween,
      msWithin,
      grandMean,
      etaSquared,
      omegaSquared,
      omegaSquaredWasNegative: omegaRaw < 0,
      postHoc: comparisons,
      postHocRun: runPostHoc,
      postHocMethod: runPostHoc ? 'tukey-hsd' : null,
      groupSizeRatio: sizeRatio,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              Welch's ANOVA                                 */
/* -------------------------------------------------------------------------- */

/**
 * Welch's F, which does not pool the within-group variances.
 *
 * Each group is weighted by its own precision (n / s²) rather than by size
 * alone, so a large but noisy group no longer dominates a small precise one.
 * The denominator degrees of freedom are non-integer, as with Welch's t.
 */
function welchAnova(
  groups: number[][],
  groupMeans: number[],
  groupVariances: number[],
): { f: number; df: [number, number]; pValue: number } | null {
  const k = groups.length;

  const weights: number[] = [];
  for (let i = 0; i < k; i += 1) {
    const v = groupVariances[i] as number;
    if (v <= 0) return null;
    weights.push((groups[i] as number[]).length / v);
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const weightedMean =
    weights.reduce((sum, weight, i) => sum + weight * (groupMeans[i] as number), 0) / totalWeight;

  let numerator = 0;
  for (let i = 0; i < k; i += 1) {
    numerator += (weights[i] as number) * ((groupMeans[i] as number) - weightedMean) ** 2;
  }
  numerator /= k - 1;

  let lambda = 0;
  for (let i = 0; i < k; i += 1) {
    const groupN = (groups[i] as number[]).length;
    lambda += (1 - (weights[i] as number) / totalWeight) ** 2 / (groupN - 1);
  }
  lambda /= k * k - 1;

  const denominator = 1 + 2 * (k - 2) * lambda;
  const f = numerator / denominator;
  const df2 = 1 / (3 * lambda);

  return { f, df: [k - 1, df2], pValue: fSf(f, k - 1, df2) };
}

/* -------------------------------------------------------------------------- */
/*                               Tukey's HSD                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every pairwise comparison, with the family-wise error rate held at α.
 *
 * The standard error uses the pooled within-group mean square from the ANOVA,
 * and the Tukey–Kramer form handles unequal group sizes — the ordinary case in
 * survey work, where the original equal-n formula does not apply.
 */
export function tukeyHsd(
  groups: number[][],
  labels: string[],
  groupMeans: number[],
  msWithin: number,
  dfWithin: number,
  level = 0.95,
): TukeyComparison[] {
  const k = groups.length;
  const comparisons: TukeyComparison[] = [];
  const critical = studentizedRangeQuantile(level, k, dfWithin);

  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const nI = (groups[i] as number[]).length;
      const nJ = (groups[j] as number[]).length;
      const difference = (groupMeans[i] as number) - (groupMeans[j] as number);

      // Tukey–Kramer standard error for unequal n.
      const se = Math.sqrt((msWithin / 2) * (1 / nI + 1 / nJ));
      const q = se === 0 ? Number.NaN : Math.abs(difference) / se;
      const pValue = Number.isFinite(q) ? studentizedRangeSf(q, k, dfWithin) : Number.NaN;
      const margin = critical * se;

      comparisons.push({
        groupA: labels[i] as string,
        groupB: labels[j] as string,
        meanDifference: difference,
        standardError: se,
        q,
        pValue,
        confidenceInterval: { level, lower: difference - margin, upper: difference + margin },
        significant: Number.isFinite(pValue) && pValue < 1 - level,
      });
    }
  }

  return comparisons;
}
