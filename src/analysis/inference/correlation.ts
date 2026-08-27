/**
 * Correlation: Pearson's r, Spearman's ρ, and the matrix of both.
 *
 * The easiest statistic to compute and one of the easiest to misuse. Three
 * things this module insists on.
 *
 * **Which coefficient, decided by measurement scale.** Pearson's r describes
 * the strength of a *linear* relationship between two interval or ratio
 * quantities. A five-point Likert item is neither: the distance between "agree"
 * and "strongly agree" is not known to equal the distance between "neutral" and
 * "agree", so the arithmetic mean of the codes has no defined meaning and
 * neither does a covariance built from it. Spearman's ρ works on ranks and asks
 * only whether one variable tends to rise with the other, which is exactly the
 * question ordinal data can answer. The recommender uses the profiler's scale
 * inference to choose; both are computed here so the choice can be shown.
 *
 * **A confidence interval, not just a p-value.** An r of .30 from 25
 * respondents and an r of .30 from 400 are the same point estimate and entirely
 * different findings — the first has an interval running from about −.11 to
 * .62, which includes "no relationship at all". Fisher's z transformation makes
 * that interval computable, and it is the honest way to report a correlation.
 *
 * **Missing data handled pairwise, and said so.** For a matrix this is the
 * right default: dropping a whole respondent because they skipped one item of
 * fifteen throws away their answers to the other fourteen. The cost is that
 * different cells rest on different samples, so every cell carries its own n,
 * and the result reports the range. A reader who sees one n for the whole
 * matrix cannot tell which correlations are thin.
 */

import { normalQuantile, tTwoTailed } from '../distributions';
import { mean, pearson, spearman, standardDeviation } from '../stats-core';
import { assessNormality, independenceCheck } from './assumptions';
import { adjustPValues, multipleComparisonRisk, type PAdjustMethod } from './multiple-comparisons';
import {
  bandForCorrelation,
  type AnalysisWarning,
  type AssumptionCheck,
  type ConfidenceInterval,
  type InferentialResult,
} from './types';

export type CorrelationMethod = 'pearson' | 'spearman';

/** Below this the estimate swings so widely that the interval is the only honest output. */
const UNSTABLE_N = 30;
const MIN_N = 4;

export class CorrelationError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'CorrelationError';
  }
}

export interface CorrelationOptions {
  method?: CorrelationMethod;
  confidenceLevel?: number;
  /**
   * Correction for the family of comparisons in a matrix. Defaults to `none`,
   * deliberately: see `multiple-comparisons.ts` for why no correction is ever
   * applied without being asked for.
   */
  pAdjust?: PAdjustMethod;
}

/* -------------------------------------------------------------------------- */
/*                             Fisher's z interval                            */
/* -------------------------------------------------------------------------- */

/**
 * Confidence interval for a correlation, via Fisher's z transformation.
 *
 * r is bounded at ±1, so its sampling distribution is skewed everywhere except
 * at zero — which is why an interval of the form r ± 1.96·SE is wrong, and
 * visibly so when it produces a bound beyond 1. The z transformation
 * (arctanh r) is approximately normal and unbounded; the interval is built
 * there and mapped back, which is what makes it asymmetric around r.
 *
 * For Spearman the standard error is inflated by Fieller's factor of √1.06,
 * because ranks carry slightly less information than the values they came from.
 */
export function fisherInterval(
  r: number,
  n: number,
  level: number,
  method: CorrelationMethod,
): ConfidenceInterval | null {
  if (!Number.isFinite(r) || Math.abs(r) >= 1) return null;
  if (n < MIN_N) return null;

  const z = Math.atanh(r);
  const factor = method === 'spearman' ? Math.sqrt(1.06) : 1;
  const se = factor / Math.sqrt(n - 3);
  const critical = normalQuantile(1 - (1 - level) / 2);

  return {
    level,
    lower: Math.tanh(z - critical * se),
    upper: Math.tanh(z + critical * se),
  };
}

/* -------------------------------------------------------------------------- */
/*                            A single correlation                            */
/* -------------------------------------------------------------------------- */

export function correlate(
  xs: number[],
  ys: number[],
  labels: [string, string],
  options: CorrelationOptions = {},
): InferentialResult {
  const method = options.method ?? 'pearson';
  const level = options.confidenceLevel ?? 0.95;

  if (xs.length !== ys.length) {
    throw new CorrelationError('analysis.correlation.error.lengthMismatch', {
      first: xs.length,
      second: ys.length,
    });
  }

  /* Pairwise deletion: a pair survives only if both of its values are present. */
  const pairsX: number[] = [];
  const pairsY: number[] = [];

  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pairsX.push(x);
      pairsY.push(y);
    }
  }

  const n = pairsX.length;
  const dropped = xs.length - n;

  if (n < MIN_N) {
    throw new CorrelationError('analysis.correlation.error.tooFewPairs', { n, minimum: MIN_N });
  }

  if (standardDeviation(pairsX) === 0 || standardDeviation(pairsY) === 0) {
    throw new CorrelationError('analysis.correlation.error.constantVariable', {
      variable: standardDeviation(pairsX) === 0 ? labels[0] : labels[1],
    });
  }

  const r = method === 'spearman' ? spearman(pairsX, pairsY) : pearson(pairsX, pairsY);

  if (!Number.isFinite(r)) {
    throw new CorrelationError('analysis.correlation.error.undefined');
  }

  /*
   * Both coefficients are tested the same way: t = r√(n−2) / √(1−r²) on n − 2
   * degrees of freedom. For Spearman this is an approximation that is good from
   * about n = 10 upward, which covers every realistic dataset; below that the
   * result is reported with a warning rather than withheld.
   */
  const df = n - 2;
  const t = Math.abs(r) >= 1 ? Number.POSITIVE_INFINITY : (r * Math.sqrt(df)) / Math.sqrt(1 - r * r);
  const pValue = Number.isFinite(t) ? tTwoTailed(t, df) : 0;

  const interval = fisherInterval(r, n, level, method);

  /* ------------------------------- assumptions ---------------------------- */

  const assumptions: AssumptionCheck[] = [independenceCheck()];
  const warnings: AnalysisWarning[] = [];

  if (method === 'pearson') {
    /*
     * Pearson assumes the pair is bivariate normal. Checking each variable
     * separately is weaker than checking the pair jointly, but it catches the
     * case that matters in practice — a badly skewed variable — and needs no
     * extra machinery.
     */
    const normalityX = assessNormality(pairsX, labels[0]);
    const normalityY = assessNormality(pairsY, labels[1]);
    assumptions.push(normalityX.check, normalityY.check);
    warnings.push(...normalityX.warnings, ...normalityY.warnings);

    if (!normalityX.parametricDefensible || !normalityY.parametricDefensible) {
      warnings.push({
        code: 'pearson-on-non-normal-data',
        severity: 'warning',
        columns: [labels[0], labels[1]],
        params: { alternative: 'spearman' },
      });
    }

    /*
     * Pearson measures *linear* association only. A perfect U-shape returns
     * r ≈ 0, and the honest reading of that zero is "no linear trend", not "no
     * relationship". There is no cheap test for this, so it is declared.
     */
    assumptions.push({ key: 'linearity', status: 'not-testable' });
  } else {
    // Spearman assumes only a monotonic relationship, which needs no normality.
    assumptions.push({ key: 'measurement-scale', status: 'met' });
  }

  if (n < UNSTABLE_N) {
    warnings.push({
      code: 'correlation-small-sample',
      severity: 'warning',
      columns: [labels[0], labels[1]],
      params: { n, threshold: UNSTABLE_N },
    });
  }

  if (method === 'spearman' && n < 10) {
    warnings.push({
      code: 'spearman-p-approximate',
      severity: 'info',
      columns: [labels[0], labels[1]],
      params: { n },
    });
  }

  if (dropped > 0) {
    warnings.push({
      code: 'incomplete-pairs-dropped',
      severity: 'info',
      columns: [labels[0], labels[1]],
      params: { dropped, supplied: xs.length, used: n },
    });
  }

  /*
   * A wide interval that straddles zero while the point estimate looks
   * substantial is the single most useful thing to say about a small-sample
   * correlation, and the thing a bare r hides.
   */
  if (interval && interval.lower < 0 && interval.upper > 0 && Math.abs(r) >= 0.2) {
    warnings.push({
      code: 'interval-includes-zero',
      severity: 'warning',
      columns: [labels[0], labels[1]],
      params: {
        r: Number(r.toFixed(3)),
        lower: Number(interval.lower.toFixed(3)),
        upper: Number(interval.upper.toFixed(3)),
      },
    });
  }

  return {
    test: method === 'spearman' ? 'correlation.spearman' : 'correlation.pearson',
    variables: [labels[0], labels[1]],
    statistic: { name: method === 'spearman' ? 'rho' : 'r', value: r },
    df,
    pValue,
    effect: { name: method === 'spearman' ? 'rho' : 'r', value: r, band: bandForCorrelation(r) },
    estimates: [
      { label: labels[0], n, mean: mean(pairsX), sd: standardDeviation(pairsX), se: standardDeviation(pairsX) / Math.sqrt(n) },
      { label: labels[1], n, mean: mean(pairsY), sd: standardDeviation(pairsY), se: standardDeviation(pairsY) / Math.sqrt(n) },
    ],
    assumptions,
    warnings,
    n,
    rowsSupplied: xs.length,
    rowsDropped: dropped,
    missingPolicy: 'pairwise',
    detail: {
      method,
      t,
      confidenceInterval: interval,
      /** r², the share of variance the two variables hold in common. */
      rSquared: r * r,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                            The correlation matrix                          */
/* -------------------------------------------------------------------------- */

export interface CorrelationCell {
  rowVariable: string;
  columnVariable: string;
  r: number;
  pValue: number;
  /** Equal to `pValue` unless a correction was explicitly requested. */
  adjustedPValue: number;
  n: number;
  confidenceInterval: ConfidenceInterval | null;
  /** Judged on the adjusted p, which equals the raw p under the default. */
  significant: boolean;
}

export interface CorrelationMatrixResult {
  method: CorrelationMethod;
  /** Which correction was applied, if any. `none` under the default. */
  pAdjust: PAdjustMethod;
  /** Comparisons made, significant results found, and how many noise alone would give. */
  risk: { comparisons: number; significant: number; expectedFalsePositives: number };
  variables: string[];
  /** Square, symmetric, with 1 on the diagonal. */
  matrix: number[][];
  cells: CorrelationCell[];
  /** Every cell rests on its own sample under pairwise deletion. */
  minN: number;
  maxN: number;
  rowsSupplied: number;
  missingPolicy: 'pairwise';
  warnings: AnalysisWarning[];
}

/**
 * Every pairwise correlation among a set of variables.
 *
 * **No p-value adjustment is applied, and that is a deliberate omission worth
 * understanding.** A matrix of ten variables contains forty-five correlations;
 * at α = .05 roughly two will reach significance from noise alone. Reporting
 * the significant ones as findings is the most common way a correlation matrix
 * misleads.
 *
 * Adjustment is not applied automatically because the correct family depends on
 * the hypothesis, which this function cannot know: a researcher testing three
 * pre-registered relationships and one exploring all forty-five need different
 * corrections, and applying Bonferroni to a matrix that was meant to be
 * descriptive would understate real effects. Instead the count of comparisons
 * and the expected number of false positives are reported so the decision can
 * be made with the numbers in view.
 */
export function correlationMatrix(
  columns: { name: string; values: number[] }[],
  options: CorrelationOptions = {},
): CorrelationMatrixResult {
  const method = options.method ?? 'pearson';
  const level = options.confidenceLevel ?? 0.95;
  const pAdjust = options.pAdjust ?? 'none';

  if (columns.length < 2) {
    throw new CorrelationError('analysis.correlation.error.tooFewVariables', {
      selected: columns.length,
    });
  }

  const names = columns.map((column) => column.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new CorrelationError('analysis.correlation.error.duplicateVariable');
  }

  const k = columns.length;
  const matrix: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(Number.NaN));
  const cells: CorrelationCell[] = [];
  const warnings: AnalysisWarning[] = [];
  const sampleSizes: number[] = [];

  for (let i = 0; i < k; i += 1) matrix[i]![i] = 1;

  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const a = columns[i] as { name: string; values: number[] };
      const b = columns[j] as { name: string; values: number[] };

      try {
        const result = correlate(a.values, b.values, [a.name, b.name], { method, confidenceLevel: level });
        const r = result.statistic.value;

        matrix[i]![j] = r;
        matrix[j]![i] = r;
        sampleSizes.push(result.n);

        cells.push({
          rowVariable: a.name,
          columnVariable: b.name,
          r,
          pValue: result.pValue,
          // Filled in below, once the whole family is known.
          adjustedPValue: result.pValue,
          n: result.n,
          confidenceInterval: (result.detail?.confidenceInterval as ConfidenceInterval | null) ?? null,
          significant: result.pValue < 1 - level,
        });
      } catch (error) {
        /*
         * One unusable pair — a constant column, or too few overlapping
         * responses — must not take down the whole matrix. The cell stays NaN
         * and the reason is reported.
         */
        warnings.push({
          code: 'correlation-cell-unavailable',
          severity: 'warning',
          columns: [a.name, b.name],
          params: {
            reason: error instanceof CorrelationError ? error.reasonKey : 'unknown',
          },
        });
      }
    }
  }

  /*
   * The correction is applied to the family as a whole, so it can only happen
   * once every cell exists. Under the default `none` this is an identity pass
   * that leaves `adjustedPValue` equal to `pValue`.
   */
  const alpha = 1 - level;
  const adjusted = adjustPValues(cells.map((cell) => cell.pValue), pAdjust);
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index] as CorrelationCell;
    cell.adjustedPValue = adjusted[index] as number;
    cell.significant = cell.adjustedPValue < alpha;
  }

  const risk = multipleComparisonRisk(cells.map((cell) => cell.pValue), alpha);

  const rowsSupplied = columns[0]?.values.length ?? 0;
  const minN = sampleSizes.length > 0 ? Math.min(...sampleSizes) : 0;
  const maxN = sampleSizes.length > 0 ? Math.max(...sampleSizes) : 0;

  /* Pairwise deletion means the cells do not share a sample. Say so when it bites. */
  if (minN !== maxN) {
    warnings.push({
      code: 'pairwise-samples-differ',
      severity: 'info',
      columns: names,
      params: { minN, maxN },
    });
  }

  /*
   * Reported whenever the family is large enough for chance alone to produce a
   * significant cell — and only when no correction was requested, since asking
   * for one is the researcher already having made this decision.
   */
  if (pAdjust === 'none' && risk.comparisons >= 10) {
    warnings.push({
      code: 'multiple-comparisons-unadjusted',
      severity: 'warning',
      columns: names,
      params: {
        comparisons: risk.comparisons,
        expectedFalsePositives: risk.expectedFalsePositives,
        significantFound: risk.significant,
        alpha,
      },
    });
  }

  if (pAdjust !== 'none') {
    warnings.push({
      code: 'p-values-adjusted',
      severity: 'info',
      columns: names,
      params: {
        method: pAdjust,
        comparisons: risk.comparisons,
        significantBefore: risk.significant,
        significantAfter: cells.filter((cell) => cell.significant).length,
      },
    });
  }

  return {
    method,
    pAdjust,
    risk,
    variables: names,
    matrix,
    cells,
    minN,
    maxN,
    rowsSupplied,
    missingPolicy: 'pairwise',
    warnings,
  };
}
