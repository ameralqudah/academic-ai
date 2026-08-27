/**
 * Ordinary least squares regression — simple and multiple.
 *
 * The most informative test in this file and the easiest to over-read. Four
 * things it is built to keep honest.
 *
 * **The coefficients are fitted by QR, not by the normal equations.** See
 * `linear-algebra.ts` for why. It matters most here, because questionnaire
 * predictors are routinely near-collinear — two items that are rewordings of
 * one another correlate at .95 and up — and the normal equations lose exactly
 * the information needed to separate them.
 *
 * **Multicollinearity is measured, not assumed away.** When two predictors
 * carry the same information the model as a whole can fit beautifully while
 * each individual coefficient becomes unstable and its sign arbitrary. R²
 * stays high, the F test stays significant, and the interpretation — "for each
 * point of X, Y rises by β" — becomes meaningless. The variance inflation
 * factor detects this, and it is reported for every predictor rather than on
 * request.
 *
 * **The residuals carry the assumptions.** Normality, constant variance and
 * independence are properties of what the model failed to explain, not of the
 * raw variables. Checking the predictors for normality — a common mistake — is
 * checking the wrong thing.
 *
 * **R² only ever rises.** Adding any predictor, including a column of random
 * numbers, increases R². Adjusted R² penalises that, and the gap between the
 * two is a direct measure of how much of the fit was bought rather than earned.
 * Both are reported, always.
 */

import { fSf, tQuantile, tTwoTailed } from '../distributions';
import {
  inverseFromR,
  leastSquares,
  qrDecompose,
  SingularMatrixError,
  type Matrix,
} from '../linear-algebra';
import { mean, standardDeviation, variance } from '../stats-core';
import { assessNormality, independenceCheck } from './assumptions';
import type {
  AnalysisWarning,
  AssumptionCheck,
  ConfidenceInterval,
  GroupEstimate,
  InferentialResult,
} from './types';
import { bandForEtaSquared } from './types';

/** Cases per predictor below which the model is fitting noise. */
const MIN_CASES_PER_PREDICTOR = 10;
/** Absolute minimum residual degrees of freedom for anything to be estimable. */
const MIN_RESIDUAL_DF = 3;
/** Conventional thresholds for the variance inflation factor. */
const VIF_WARNING = 5;
const VIF_SEVERE = 10;

export class RegressionError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'RegressionError';
  }
}

export interface RegressionOptions {
  confidenceLevel?: number;
  /** Fit without an intercept. Rarely correct; see the warning it raises. */
  noIntercept?: boolean;
}

export interface RegressionCoefficient {
  name: string;
  /** The raw slope: change in the outcome per unit of this predictor. */
  b: number;
  standardError: number;
  /** Standardised slope (β), comparable across predictors on different scales. */
  beta: number;
  t: number;
  pValue: number;
  confidenceInterval: ConfidenceInterval;
  /** Null for the intercept, which has no variance to inflate. */
  vif: number | null;
  significant: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                    OLS                                     */
/* -------------------------------------------------------------------------- */

export function linearRegression(
  outcome: { name: string; values: number[] },
  predictors: { name: string; values: number[] }[],
  options: RegressionOptions = {},
): InferentialResult {
  const level = options.confidenceLevel ?? 0.95;
  const withIntercept = options.noIntercept !== true;

  if (predictors.length === 0) {
    throw new RegressionError('analysis.regression.error.noPredictors');
  }

  const names = predictors.map((predictor) => predictor.name);
  if (new Set(names).size !== names.length) {
    throw new RegressionError('analysis.regression.error.duplicatePredictor');
  }
  if (names.includes(outcome.name)) {
    throw new RegressionError('analysis.regression.error.outcomeAmongPredictors', {
      variable: outcome.name,
    });
  }

  const supplied = outcome.values.length;
  for (const predictor of predictors) {
    if (predictor.values.length !== supplied) {
      throw new RegressionError('analysis.regression.error.lengthMismatch', {
        variable: predictor.name,
        expected: supplied,
        actual: predictor.values.length,
      });
    }
  }

  /* ------------------------------ listwise deletion ----------------------- */

  /*
   * Listwise, and it has to be: a case missing any predictor contributes no row
   * to the design matrix. Pairwise deletion — legitimate for a correlation
   * matrix — would here mean fitting different coefficients on different
   * subsamples and reporting them as one model.
   */
  const y: number[] = [];
  const xColumns: number[][] = predictors.map(() => []);

  for (let row = 0; row < supplied; row += 1) {
    const outcomeValue = outcome.values[row] as number;
    if (!Number.isFinite(outcomeValue)) continue;

    const predictorValues = predictors.map((predictor) => predictor.values[row] as number);
    if (predictorValues.some((value) => !Number.isFinite(value))) continue;

    y.push(outcomeValue);
    predictorValues.forEach((value, column) => (xColumns[column] as number[]).push(value));
  }

  const n = y.length;
  const p = predictors.length;
  const parameters = p + (withIntercept ? 1 : 0);
  const dfResidual = n - parameters;

  if (dfResidual < MIN_RESIDUAL_DF) {
    throw new RegressionError('analysis.regression.error.tooFewCases', {
      n,
      predictors: p,
      minimum: parameters + MIN_RESIDUAL_DF,
    });
  }

  if (standardDeviation(y) === 0) {
    throw new RegressionError('analysis.regression.error.constantOutcome', { variable: outcome.name });
  }

  const constantPredictor = xColumns.findIndex((column) => standardDeviation(column) === 0);
  if (constantPredictor >= 0) {
    throw new RegressionError('analysis.regression.error.constantPredictor', {
      variable: names[constantPredictor] as string,
    });
  }

  /* --------------------------------- the fit ------------------------------ */

  const design: Matrix = Array.from({ length: n }, (_, row) => {
    const values = xColumns.map((column) => column[row] as number);
    return withIntercept ? [1, ...values] : values;
  });

  let coefficients: number[];
  let xtxInverse: Matrix;

  try {
    coefficients = leastSquares(design, y);
    xtxInverse = inverseFromR(qrDecompose(design, y).r);
  } catch (error) {
    if (error instanceof SingularMatrixError) {
      /*
       * An exactly collinear predictor — the same variable entered twice, or a
       * set of dummies including every category. There is no unique solution,
       * and inventing one by dropping a column silently would hide a modelling
       * error the researcher needs to see.
       */
      throw new RegressionError('analysis.regression.error.perfectCollinearity');
    }
    throw error;
  }

  const fitted = design.map((row) =>
    row.reduce((sum, value, index) => sum + value * (coefficients[index] as number), 0),
  );
  const residuals = y.map((value, index) => value - (fitted[index] as number));

  /* ------------------------------- model fit ------------------------------ */

  const meanY = mean(y);
  const ssTotal = withIntercept
    ? y.reduce((sum, value) => sum + (value - meanY) ** 2, 0)
    : y.reduce((sum, value) => sum + value * value, 0);
  const ssResidual = residuals.reduce((sum, value) => sum + value * value, 0);
  const ssRegression = ssTotal - ssResidual;

  const dfModel = p;
  const rSquared = ssTotal === 0 ? Number.NaN : ssRegression / ssTotal;

  /*
   * Adjusted R² penalises each parameter spent. The gap between it and R² is
   * how much of the apparent fit came from having predictors rather than from
   * those predictors explaining anything.
   */
  const adjustedRSquared = 1 - ((1 - rSquared) * (n - (withIntercept ? 1 : 0))) / dfResidual;

  const msResidual = ssResidual / dfResidual;
  const msRegression = ssRegression / dfModel;
  const f = msResidual === 0 ? Number.POSITIVE_INFINITY : msRegression / msResidual;
  const modelP = Number.isFinite(f) ? fSf(f, dfModel, dfResidual) : 0;

  const standardError = Math.sqrt(msResidual);

  /* ----------------------------- coefficients ----------------------------- */

  const critical = tQuantile(1 - (1 - level) / 2, dfResidual);
  const sdY = standardDeviation(y);
  const alpha = 1 - level;

  const vifs = p > 1 ? varianceInflationFactors(xColumns, names) : new Array<number>(p).fill(1);

  const built: RegressionCoefficient[] = coefficients.map((b, index) => {
    const isIntercept = withIntercept && index === 0;
    const predictorIndex = withIntercept ? index - 1 : index;

    const se = Math.sqrt(msResidual * ((xtxInverse[index] as number[])[index] as number));
    const t = se === 0 ? Number.NaN : b / se;
    const pValue = Number.isFinite(t) ? tTwoTailed(t, dfResidual) : Number.NaN;

    /*
     * The standardised coefficient: what the slope would be if both variables
     * were expressed in standard deviations. This is what makes two predictors
     * on different scales — years of experience and a five-point rating —
     * comparable in importance.
     */
    const beta = isIntercept
      ? Number.NaN
      : (b * standardDeviation(xColumns[predictorIndex] as number[])) / sdY;

    return {
      name: isIntercept ? '(intercept)' : (names[predictorIndex] as string),
      b,
      standardError: se,
      beta,
      t,
      pValue,
      confidenceInterval: { level, lower: b - critical * se, upper: b + critical * se },
      vif: isIntercept ? null : ((vifs[predictorIndex] as number) ?? null),
      significant: Number.isFinite(pValue) && pValue < alpha,
    };
  });

  /* ------------------------------ assumptions ----------------------------- */

  const warnings: AnalysisWarning[] = [];
  const assumptions: AssumptionCheck[] = [];

  // Normality applies to the residuals, not to any of the variables.
  const residualNormality = assessNormality(residuals, `${outcome.name} (residuals)`);
  assumptions.push({ ...residualNormality.check, detail: { ...residualNormality.check.detail, on: 'residuals' } });
  warnings.push(...residualNormality.warnings);

  // Autocorrelation of residuals.
  const durbinWatson = durbinWatsonStatistic(residuals);
  const autocorrelated = durbinWatson < 1.5 || durbinWatson > 2.5;
  assumptions.push({
    key: 'no-autocorrelation',
    status: autocorrelated ? 'violated' : 'met',
    statistic: durbinWatson,
    detail: { rule: 'between 1.5 and 2.5' },
  });

  if (autocorrelated) {
    warnings.push({
      code: 'residual-autocorrelation',
      severity: 'warning',
      columns: [outcome.name],
      params: { durbinWatson: Number(durbinWatson.toFixed(3)) },
    });
  }

  // Multicollinearity.
  const worstVif = p > 1 ? Math.max(...vifs) : 1;
  const severe = built.filter((coefficient) => (coefficient.vif ?? 0) >= VIF_SEVERE);
  const elevated = built.filter(
    (coefficient) => (coefficient.vif ?? 0) >= VIF_WARNING && (coefficient.vif ?? 0) < VIF_SEVERE,
  );

  assumptions.push({
    key: 'multicollinearity',
    status: severe.length > 0 ? 'violated' : elevated.length > 0 ? 'inconclusive' : 'met',
    statistic: worstVif,
    detail: { rule: `VIF below ${VIF_WARNING}`, worst: Number(worstVif.toFixed(3)) },
  });

  if (severe.length > 0) {
    warnings.push({
      code: 'severe-multicollinearity',
      severity: 'error',
      columns: severe.map((coefficient) => coefficient.name),
      params: { threshold: VIF_SEVERE, worst: Number(worstVif.toFixed(2)) },
    });
  } else if (elevated.length > 0) {
    warnings.push({
      code: 'elevated-multicollinearity',
      severity: 'warning',
      columns: elevated.map((coefficient) => coefficient.name),
      params: { threshold: VIF_WARNING, worst: Number(worstVif.toFixed(2)) },
    });
  }

  // Homoscedasticity, by correlating |residual| with the fitted value.
  const spreadTrend = heteroscedasticityTrend(fitted, residuals);
  assumptions.push({
    key: 'homogeneity-of-variance',
    status: Math.abs(spreadTrend) > 0.3 ? 'violated' : 'met',
    statistic: spreadTrend,
    detail: { on: 'residuals', rule: '|corr(|residual|, fitted)| below 0.3' },
  });

  if (Math.abs(spreadTrend) > 0.3) {
    warnings.push({
      code: 'heteroscedasticity',
      severity: 'warning',
      columns: [outcome.name],
      params: { trend: Number(spreadTrend.toFixed(3)) },
    });
  }

  assumptions.push(independenceCheck());
  assumptions.push({ key: 'linearity', status: 'not-testable' });

  /* -------------------------------- warnings ------------------------------ */

  const casesPerPredictor = n / p;
  if (casesPerPredictor < MIN_CASES_PER_PREDICTOR) {
    warnings.push({
      code: 'too-few-cases-per-predictor',
      severity: 'warning',
      columns: names,
      params: {
        cases: n,
        predictors: p,
        ratio: Number(casesPerPredictor.toFixed(1)),
        recommended: MIN_CASES_PER_PREDICTOR,
      },
    });
  }

  /*
   * A large gap between R² and its adjusted form means predictors were spent
   * without buying explanation — the signature of a model with more variables
   * than the data can support.
   */
  if (Number.isFinite(rSquared) && rSquared - adjustedRSquared > 0.1) {
    warnings.push({
      code: 'r-squared-inflated-by-predictors',
      severity: 'warning',
      columns: names,
      params: {
        rSquared: Number(rSquared.toFixed(3)),
        adjusted: Number(adjustedRSquared.toFixed(3)),
        predictors: p,
      },
    });
  }

  if (!withIntercept) {
    /*
     * Without an intercept the model is forced through the origin, R² is
     * computed against a different baseline and is not comparable with the
     * usual figure, and the residuals need not sum to zero. Almost always a
     * mistake.
     */
    warnings.push({ code: 'fitted-without-intercept', severity: 'warning', columns: [outcome.name] });
  }

  const dropped = supplied - n;
  if (dropped > 0) {
    warnings.push({
      code: 'listwise-deletion',
      severity: dropped / supplied > 0.2 ? 'warning' : 'info',
      columns: [outcome.name, ...names],
      params: {
        dropped,
        supplied,
        used: n,
        percent: Number(((dropped / supplied) * 100).toFixed(1)),
      },
    });
  }

  /* -------------------------------- estimates ----------------------------- */

  const estimates: GroupEstimate[] = [
    {
      label: outcome.name,
      n,
      mean: meanY,
      sd: sdY,
      se: sdY / Math.sqrt(n),
    },
  ];

  return {
    test: 'regression.ols',
    variables: [outcome.name, ...names],
    statistic: { name: 'F', value: f },
    df: [dfModel, dfResidual],
    pValue: modelP,
    effect: {
      name: 'rSquared',
      value: rSquared,
      band: bandForEtaSquared(rSquared),
    },
    estimates,
    assumptions,
    warnings,
    n,
    rowsSupplied: supplied,
    rowsDropped: dropped,
    missingPolicy: 'listwise',
    detail: {
      coefficients: built,
      rSquared,
      adjustedRSquared,
      standardError,
      ssRegression,
      ssResidual,
      ssTotal,
      dfModel,
      dfResidual,
      msRegression,
      msResidual,
      durbinWatson,
      worstVif,
      withIntercept,
      residuals,
      fitted,
      /** The multiple correlation, R — the square root of R². */
      multipleR: Math.sqrt(Math.max(0, rSquared)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          Multicollinearity                                 */
/* -------------------------------------------------------------------------- */

/**
 * Variance inflation factor for each predictor.
 *
 * VIFⱼ = 1 / (1 − R²ⱼ), where R²ⱼ comes from regressing predictor j on all the
 * others. It answers precisely: by what factor is this coefficient's variance
 * larger than it would be if this predictor were unrelated to the rest? A VIF
 * of 10 means the standard error is √10 ≈ 3.2 times what it should be, which is
 * usually enough to turn a real effect non-significant.
 *
 * A predictor that is an exact linear combination of the others gives an
 * infinite VIF; that is reported rather than crashed on, since the caller has
 * already been told about perfect collinearity by the fit itself.
 */
export function varianceInflationFactors(columns: number[][], names: string[]): number[] {
  const p = columns.length;
  if (p < 2) return new Array<number>(p).fill(1);

  const n = (columns[0] as number[]).length;

  return columns.map((target, index) => {
    const others = columns.filter((_, other) => other !== index);
    const design: Matrix = Array.from({ length: n }, (_, row) => [
      1,
      ...others.map((column) => column[row] as number),
    ]);

    try {
      const beta = leastSquares(design, target);
      const fitted = design.map((row) =>
        row.reduce((sum, value, i) => sum + value * (beta[i] as number), 0),
      );

      const targetMean = mean(target);
      const ssTotal = target.reduce((sum, value) => sum + (value - targetMean) ** 2, 0);
      const ssResidual = target.reduce((sum, value, row) => sum + (value - (fitted[row] as number)) ** 2, 0);

      if (ssTotal === 0) return Number.POSITIVE_INFINITY;
      const rSquared = 1 - ssResidual / ssTotal;
      if (rSquared >= 1) return Number.POSITIVE_INFINITY;

      return 1 / (1 - rSquared);
    } catch {
      void names;
      return Number.POSITIVE_INFINITY;
    }
  });
}

/* -------------------------------------------------------------------------- */
/*                            Residual diagnostics                            */
/* -------------------------------------------------------------------------- */

/**
 * The Durbin–Watson statistic, which ranges from 0 to 4 and sits near 2 when
 * consecutive residuals are unrelated.
 *
 * Below 2 indicates positive autocorrelation — each residual resembling the one
 * before it. That is a real risk in this product's setting whenever cases were
 * entered in a meaningful order: responses collected class by class, or a
 * spreadsheet sorted by the outcome before analysis. It matters because
 * correlated residuals make the standard errors too small, so everything looks
 * more significant than it is.
 */
export function durbinWatsonStatistic(residuals: number[]): number {
  if (residuals.length < 2) return Number.NaN;

  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < residuals.length; i += 1) {
    const value = residuals[i] as number;
    denominator += value * value;
    if (i > 0) numerator += (value - (residuals[i - 1] as number)) ** 2;
  }

  return denominator === 0 ? Number.NaN : numerator / denominator;
}

/**
 * A simple check for non-constant residual variance: the correlation between
 * the absolute residual and the fitted value.
 *
 * Not a formal test — Breusch–Pagan and White both are, and either could be
 * added later — but it catches the pattern that actually occurs, where spread
 * grows with the predicted value. The point is to raise the question, which the
 * researcher then answers by looking at the residual plot.
 */
export function heteroscedasticityTrend(fitted: number[], residuals: number[]): number {
  const absolute = residuals.map((value) => Math.abs(value));
  if (variance(absolute) === 0 || variance(fitted) === 0) return 0;

  const meanFitted = mean(fitted);
  const meanAbsolute = mean(absolute);

  let covariance = 0;
  let varianceFitted = 0;
  let varianceAbsolute = 0;

  for (let i = 0; i < fitted.length; i += 1) {
    const dx = (fitted[i] as number) - meanFitted;
    const dy = (absolute[i] as number) - meanAbsolute;
    covariance += dx * dy;
    varianceFitted += dx * dx;
    varianceAbsolute += dy * dy;
  }

  if (varianceFitted === 0 || varianceAbsolute === 0) return 0;
  return covariance / Math.sqrt(varianceFitted * varianceAbsolute);
}
