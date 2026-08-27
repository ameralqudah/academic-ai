/**
 * The vocabulary of inferential results.
 *
 * Every test in this product — t, ANOVA, correlation, chi-square, regression —
 * returns the same envelope. That uniformity is the point, and it is worth
 * stating why, because the obvious alternative (each test returning whatever
 * shape suits it) is easier to write and much worse to live with.
 *
 * A t-test result and a chi-square result have almost nothing in common
 * statistically. But everything downstream of them treats them identically: the
 * interface renders them with one component, the exporter writes them into one
 * kind of table, and — when the orchestrator arrives — the writing agent
 * receives them in one prompt format. Three consumers, each of which would
 * otherwise need a branch per test, and would grow a new branch every time a
 * test is added. Fixing the shape once here is what keeps that from happening.
 *
 * Two things are deliberately non-optional in the envelope.
 *
 * **The effect size.** A p-value answers "could this be chance?" and nothing
 * else. With four hundred respondents a trivial difference clears p < .05, and
 * a student who reports only the p-value has reported that their sample was
 * large. Every test here carries the magnitude alongside the probability.
 *
 * **The assumptions.** They are structured data rather than a note in the
 * documentation, because a violated assumption changes which test is correct,
 * and that decision has to survive the trip to the interface intact.
 */

import type { MeasurementScale } from '../types';

/* -------------------------------------------------------------------------- */
/*                                 Identity                                   */
/* -------------------------------------------------------------------------- */

export type TestKey =
  | 't.oneSample'
  | 't.independent'
  | 't.paired'
  | 'anova.oneWay'
  | 'correlation.pearson'
  | 'correlation.spearman'
  | 'chiSquare.independence'
  | 'chiSquare.goodnessOfFit'
  | 'regression.ols'
  | 'normality.shapiroWilk'
  | 'homogeneity.levene'
  | 'reliability.cronbachAlpha'
  // Non-parametric alternatives. Named here because a violated assumption must
  // be able to point at its replacement before that replacement is implemented.
  | 'nonparametric.mannWhitney'
  | 'nonparametric.wilcoxon'
  | 'nonparametric.kruskalWallis';

/* -------------------------------------------------------------------------- */
/*                                Effect size                                 */
/* -------------------------------------------------------------------------- */

export type EffectBand = 'negligible' | 'small' | 'medium' | 'large';

export interface EffectSize {
  /** 'cohensD', 'hedgesG', 'etaSquared', 'cramersV', 'r', 'rSquared', … */
  name: string;
  value: number;
  band: EffectBand;
}

/**
 * Cohen's conventional cut points for a standardised mean difference.
 *
 * These are conventions, not laws, and Cohen said so himself when he proposed
 * them. They are used because a reader needs some anchor for "is 0.42 a lot",
 * and a discipline-specific benchmark — where one exists — beats them.
 */
export function bandForCohensD(d: number): EffectBand {
  const magnitude = Math.abs(d);
  if (magnitude < 0.2) return 'negligible';
  if (magnitude < 0.5) return 'small';
  if (magnitude < 0.8) return 'medium';
  return 'large';
}

/** Cohen's cut points for a correlation coefficient. */
export function bandForCorrelation(r: number): EffectBand {
  const magnitude = Math.abs(r);
  if (magnitude < 0.1) return 'negligible';
  if (magnitude < 0.3) return 'small';
  if (magnitude < 0.5) return 'medium';
  return 'large';
}

/** Cut points for η² and similar proportion-of-variance measures. */
export function bandForEtaSquared(eta: number): EffectBand {
  if (eta < 0.01) return 'negligible';
  if (eta < 0.06) return 'small';
  if (eta < 0.14) return 'medium';
  return 'large';
}

/**
 * Cramér's V, whose cut points depend on the size of the table.
 *
 * Unlike the others this one genuinely cannot be a fixed scale: V is bounded by
 * the smaller dimension of the contingency table, so 0.25 in a 2×2 means
 * something quite different from 0.25 in a 5×6. The degrees of freedom of the
 * smaller dimension rescale it (Cohen's w convention).
 */
export function bandForCramersV(v: number, smallerDimension: number): EffectBand {
  const df = Math.max(1, smallerDimension - 1);
  const scaled = v * Math.sqrt(df);
  if (scaled < 0.1) return 'negligible';
  if (scaled < 0.3) return 'small';
  if (scaled < 0.5) return 'medium';
  return 'large';
}

/* -------------------------------------------------------------------------- */
/*                                Assumptions                                 */
/* -------------------------------------------------------------------------- */

export type AssumptionKey =
  | 'normality'
  | 'homogeneity-of-variance'
  | 'independence'
  | 'expected-cell-counts'
  | 'linearity'
  | 'multicollinearity'
  | 'no-autocorrelation'
  | 'sample-size'
  | 'measurement-scale';

export type AssumptionStatus =
  | 'met'
  | 'violated'
  | 'inconclusive'
  /**
   * Some assumptions cannot be checked from the data at all. Independence of
   * observations is the important one: whether two respondents influenced each
   * other is a fact about how the study was run, and no statistic can recover
   * it. Reported honestly as the researcher's responsibility rather than
   * quietly omitted, because omission reads as "checked and fine".
   */
  | 'not-testable';

export interface AssumptionCheck {
  key: AssumptionKey;
  status: AssumptionStatus;
  /** The test used to check it, when one was. */
  via?: TestKey;
  statistic?: number;
  pValue?: number;
  /** What to use instead when this assumption is violated. */
  alternative?: TestKey;
  detail?: Record<string, string | number>;
}

/* -------------------------------------------------------------------------- */
/*                                  Results                                   */
/* -------------------------------------------------------------------------- */

export interface ConfidenceInterval {
  level: number;
  lower: number;
  upper: number;
}

/** One group, one variable, or one condition — whatever the test compares. */
export interface GroupEstimate {
  label: string;
  n: number;
  mean: number;
  sd: number;
  /** Standard error of the mean. */
  se: number;
  confidenceInterval?: ConfidenceInterval;
}

export type AnalysisWarningSeverity = 'info' | 'warning' | 'error';

/**
 * Same shape as the reliability module's warnings, and for the same reason:
 * a code and parameters rather than a sentence, so the message can be said in
 * Arabic or English without the statistics module knowing either language.
 */
export interface AnalysisWarning {
  code: string;
  severity: AnalysisWarningSeverity;
  columns: string[];
  params?: Record<string, string | number>;
}

/**
 * How rows with missing values were handled. Stated per result rather than set
 * globally, because the right policy genuinely differs by test: a correlation
 * matrix can use every pair that is complete, while a regression needs every
 * predictor present in the same row, and the two therefore report different
 * sample sizes from the same file. A reader who is not told which was used
 * cannot reconcile them.
 */
export type MissingPolicy = 'listwise' | 'pairwise' | 'per-group';

export interface InferentialResult {
  test: TestKey;
  /** Columns the test was run on, in the order the test defines. */
  variables: string[];

  statistic: { name: string; value: number };
  /** A single number, or [numerator, denominator] for F. */
  df: number | [number, number];
  pValue: number;

  effect: EffectSize | null;
  estimates: GroupEstimate[];
  assumptions: AssumptionCheck[];
  warnings: AnalysisWarning[];

  /** Cases actually analysed. */
  n: number;
  rowsSupplied: number;
  rowsDropped: number;
  missingPolicy: MissingPolicy;

  /**
   * Set when a secondary result is reported alongside the main one — the
   * clearest case being Student's t next to Welch's. The interface shows both
   * and says which is primary; this field is the one that is not.
   */
  secondary?: {
    label: string;
    statistic: { name: string; value: number };
    df: number | [number, number];
    pValue: number;
    effect: EffectSize | null;
  };

  /** Anything a specific test reports that the envelope has no room for. */
  detail?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*                              Variable roles                                */
/* -------------------------------------------------------------------------- */

/**
 * What a column is being asked to do in an analysis.
 *
 * The recommender needs this: the same two columns support entirely different
 * tests depending on which is the outcome. It is the researcher's declaration,
 * never inferred — deciding for them which of their variables is the dependent
 * one would be deciding what their study is about.
 */
export type VariableRole = 'dependent' | 'independent' | 'grouping' | 'covariate' | 'paired';

export interface VariableSpec {
  column: string;
  role: VariableRole;
  /** Carried from the profiler; the recommender reads it rather than re-guessing. */
  scale: MeasurementScale;
}
