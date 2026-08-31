/**
 * Logistic regression for a binary outcome.
 *
 * The gap that mattered most after the rank-based tests. A great deal of
 * education and management research asks whether something happened — passed or
 * failed, continued or withdrew, adopted or did not — and linear regression is
 * simply invalid for it: it predicts probabilities outside zero and one, and its
 * errors cannot be normal when the outcome takes two values. Until now the
 * recommender named this and declined to run it.
 *
 * **Fitted by iteratively reweighted least squares.** There is no closed form
 * for the maximum-likelihood estimates, so the fit is a sequence of weighted
 * linear solves that converge on them. Each iteration reuses the same
 * Householder QR the linear model uses, which is worth more than it looks: the
 * numerical care taken there — avoiding the normal equations and their squared
 * condition number — carries over intact rather than being reinvented less
 * carefully here.
 *
 * **Separation is detected and reported, not hidden.** When a predictor
 * perfectly divides the outcome the likelihood has no maximum: coefficients run
 * away toward infinity and standard errors explode. The fit appears to succeed
 * and produces an odds ratio in the millions. A researcher shown that without
 * warning will report it. It is the single most common way logistic regression
 * goes wrong in practice, and the check for it is not optional.
 */

import { chiSquareSf, normalSf } from '../distributions';
import { backSubstitute, qrDecompose, type Matrix, type Vector } from '../linear-algebra';

import type { AnalysisWarning, AssumptionCheck, InferentialResult } from './types';

/** Enough for any well-behaved fit; failure to converge by here means something is wrong. */
const MAX_ITERATIONS = 50;
/** Convergence when the log-likelihood stops moving by more than this. */
const TOLERANCE = 1e-10;
/** Above this a coefficient is not an estimate, it is a symptom of separation. */
const SEPARATION_THRESHOLD = 10;
/** Cases per predictor below which the estimates are not trustworthy. */
const MIN_EVENTS_PER_PREDICTOR = 10;

export class LogisticError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'LogisticError';
  }
}

export interface LogisticCoefficient {
  name: string;
  /** The coefficient on the log-odds scale. */
  b: number;
  standardError: number;
  /** exp(b): the multiplicative change in odds per unit. What gets reported. */
  oddsRatio: number;
  oddsRatioLower: number;
  oddsRatioUpper: number;
  /** Wald z and its two-sided p-value. */
  z: number;
  pValue: number;
}

export interface LogisticOptions {
  confidenceLevel?: number;
}

export function logisticRegression(
  outcome: { name: string; values: number[] },
  predictors: { name: string; values: number[] }[],
  options: LogisticOptions = {},
): InferentialResult {
  if (predictors.length === 0) {
    throw new LogisticError('analysis.logistic.error.noPredictors');
  }

  /* Complete cases only: a row missing any value contributes nothing. */
  const rows: { y: number; x: number[] }[] = [];

  for (let i = 0; i < outcome.values.length; i += 1) {
    const y = outcome.values[i] as number;
    if (!Number.isFinite(y)) continue;

    const x = predictors.map((predictor) => predictor.values[i] as number);
    if (x.some((value) => !Number.isFinite(value))) continue;

    rows.push({ y, x });
  }

  if (rows.length === 0) {
    throw new LogisticError('analysis.logistic.error.noCompleteCases');
  }

  /*
   * The outcome must be binary, and it is recoded rather than assumed. A column
   * holding 1/2, or "yes"/"no" already mapped to two numbers, is common — what
   * matters is that there are exactly two distinct values, with the larger
   * treated as the event.
   */
  const distinct = [...new Set(rows.map((row) => row.y))].sort((a, b) => a - b);

  /*
   * A single value is its own problem and gets its own message. "Not binary"
   * is technically true of a constant outcome and tells the researcher to look
   * for a third level that is not there; "never varies" points at what is
   * actually wrong.
   */
  if (distinct.length === 1) {
    throw new LogisticError('analysis.logistic.error.outcomeConstant', { variable: outcome.name });
  }

  if (distinct.length !== 2) {
    throw new LogisticError('analysis.logistic.error.outcomeNotBinary', {
      variable: outcome.name,
      levels: distinct.length,
    });
  }

  const [zeroValue, oneValue] = distinct as [number, number];
  const y: number[] = rows.map((row) => (row.y === oneValue ? 1 : 0));

  const eventCount = y.reduce((sum, value) => sum + value, 0);
  const nonEventCount = y.length - eventCount;

  if (eventCount === 0 || nonEventCount === 0) {
    throw new LogisticError('analysis.logistic.error.outcomeConstant', { variable: outcome.name });
  }

  /* Design matrix with an intercept column. */
  const n = rows.length;
  const p = predictors.length + 1;

  if (n <= p) {
    throw new LogisticError('analysis.logistic.error.tooFewCases', {
      n,
      predictors: predictors.length,
      minimum: p + 1,
    });
  }

  const design: Matrix = rows.map((row) => [1, ...row.x]);

  for (let j = 0; j < predictors.length; j += 1) {
    const column = rows.map((row) => row.x[j] as number);
    if (new Set(column).size === 1) {
      throw new LogisticError('analysis.logistic.error.constantPredictor', {
        variable: predictors[j]?.name ?? `x${j + 1}`,
      });
    }
  }

  /* ------------------------------- the fit ------------------------------- */

  const fit = fitIrls(design, y, p, n);

  /* ------------------------------ inference ------------------------------ */

  const level = options.confidenceLevel ?? 0.95;
  const critical = zQuantile(1 - (1 - level) / 2);

  const names = ['(Intercept)', ...predictors.map((predictor) => predictor.name)];
  const coefficients: LogisticCoefficient[] = [];

  for (let j = 0; j < p; j += 1) {
    const b = fit.beta[j] as number;
    const se = fit.standardErrors[j] as number;
    const z = se > 0 ? b / se : 0;

    coefficients.push({
      name: names[j] as string,
      b,
      standardError: se,
      oddsRatio: Math.exp(b),
      /*
       * The interval is built on the log-odds scale and then exponentiated,
       * which is why it is asymmetric around the odds ratio. Computing it
       * directly on the odds scale would produce a lower bound that can fall
       * below zero — impossible for a ratio.
       */
      oddsRatioLower: Math.exp(b - critical * se),
      oddsRatioUpper: Math.exp(b + critical * se),
      z,
      pValue: Math.min(1, 2 * normalSf(Math.abs(z))),
    });
  }

  /*
   * The likelihood-ratio test against the intercept-only model: the logistic
   * equivalent of the F test, and the thing that says whether the predictors
   * collectively explain anything.
   */
  const baseRate = eventCount / n;
  const nullLogLikelihood =
    eventCount * Math.log(baseRate) + nonEventCount * Math.log(1 - baseRate);

  const chiSquare = 2 * (fit.logLikelihood - nullLogLikelihood);
  const df = predictors.length;
  const pValue = chiSquareSf(Math.max(0, chiSquare), df);

  /*
   * Nagelkerke R². There is no variance to partition here, so every "R²" for a
   * logistic model is an analogy; Nagelkerke rescales Cox–Snell so that it can
   * reach 1, which is what makes it comparable across models. Reported as a
   * pseudo measure, never as explained variance.
   */
  const coxSnell = 1 - Math.exp((2 * (nullLogLikelihood - fit.logLikelihood)) / n);
  const maxCoxSnell = 1 - Math.exp((2 * nullLogLikelihood) / n);
  const nagelkerke = maxCoxSnell > 0 ? coxSnell / maxCoxSnell : 0;

  /* Classification accuracy at the conventional half-probability cut. */
  let correct = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = (fit.fitted[i] as number) >= 0.5 ? 1 : 0;
    if (predicted === y[i]) correct += 1;
  }
  const accuracy = correct / n;

  /* ------------------------------ warnings ------------------------------- */

  const warnings: AnalysisWarning[] = [];

  /*
   * Separation, checked first because everything else the model reports is
   * meaningless when it is present. A coefficient above ten on the log-odds
   * scale is an odds ratio above twenty thousand, which no real predictor
   * produces — it means the likelihood had no maximum and the fit walked off
   * toward infinity until the iteration limit stopped it.
   */
  /*
   * The intercept is checked too, and excluding it was a mistake caught by a
   * test. Perfect separation on a predictor whose values are large shows up as
   * a modest slope and an enormous intercept — coefficients of 0.46 and −31.6
   * for a variable that divides the outcome exactly. Checking only the slopes
   * missed it entirely and reported the model as sound.
   */
  const separated = coefficients.filter(
    (coefficient) => Math.abs(coefficient.b) > SEPARATION_THRESHOLD,
  );

  /*
   * A standard error far larger than its own coefficient is the other
   * signature: the likelihood is flat, so the estimate could be almost
   * anything. It catches cases where the coefficients themselves stay moderate.
   */
  const unstable = coefficients.filter(
    (coefficient) =>
      coefficient.standardError > 10 &&
      coefficient.standardError > Math.abs(coefficient.b) * 3,
  );

  if (separated.length > 0 || unstable.length > 0 || !fit.converged) {
    warnings.push({
      code: 'logistic-separation',
      severity: 'error',
      columns: [...new Set([...separated, ...unstable].map((coefficient) => coefficient.name))],
      params: { iterations: fit.iterations },
    });
  }

  /*
   * Events per variable, which is the sample-size rule that actually binds for
   * logistic models. Three hundred cases with eight events supports one
   * predictor, not eight — and the count that matters is the smaller of the two
   * outcome groups, not the total.
   */
  const limiting = Math.min(eventCount, nonEventCount);
  const eventsPerPredictor = limiting / predictors.length;

  if (eventsPerPredictor < MIN_EVENTS_PER_PREDICTOR) {
    warnings.push({
      code: 'logistic-too-few-events',
      severity: eventsPerPredictor < 5 ? 'error' : 'warning',
      columns: [],
      params: {
        events: limiting,
        predictors: predictors.length,
        ratio: Number(eventsPerPredictor.toFixed(1)),
        recommended: MIN_EVENTS_PER_PREDICTOR,
      },
    });
  }

  /*
   * A very unbalanced outcome makes accuracy misleading: predicting the common
   * class every time scores well and explains nothing. Said plainly, because
   * accuracy is the number a reader anchors on.
   */
  const eventRate = eventCount / n;
  if (eventRate < 0.1 || eventRate > 0.9) {
    warnings.push({
      code: 'logistic-imbalanced-outcome',
      severity: 'warning',
      columns: [outcome.name],
      params: {
        percent: Number((eventRate * 100).toFixed(1)),
        baseline: Number((Math.max(eventRate, 1 - eventRate) * 100).toFixed(1)),
      },
    });
  }

  if (rows.length < outcome.values.length) {
    warnings.push({
      code: 'listwise-deletion',
      severity: 'info',
      columns: [],
      params: { dropped: outcome.values.length - rows.length, supplied: outcome.values.length },
    });
  }

  const assumptions: AssumptionCheck[] = [
    { key: 'independence', status: 'not-testable' },
    {
      /* Linearity of the log-odds, not of the outcome — a distinction worth stating. */
      key: 'linearity',
      status: 'not-testable',
    },
    {
      key: 'sample-size',
      status: eventsPerPredictor >= MIN_EVENTS_PER_PREDICTOR ? 'met' : 'violated',
      statistic: Number(eventsPerPredictor.toFixed(2)),
    },
  ];

  return {
    test: 'regression.logistic',
    variables: [outcome.name, ...predictors.map((predictor) => predictor.name)],
    statistic: { name: 'chi-square', value: chiSquare },
    df,
    pValue,
    effect: {
      name: 'nagelkerkeR2',
      value: nagelkerke,
      band: bandForPseudoR2(nagelkerke),
    },
    estimates: [],
    assumptions,
    warnings,
    n,
    rowsSupplied: outcome.values.length,
    rowsDropped: outcome.values.length - n,
    missingPolicy: 'listwise',
    detail: {
      coefficients,
      logLikelihood: fit.logLikelihood,
      nullLogLikelihood,
      coxSnellR2: coxSnell,
      nagelkerkeR2: nagelkerke,
      accuracy,
      eventCount,
      nonEventCount,
      eventCoding: { event: oneValue, nonEvent: zeroValue },
      iterations: fit.iterations,
      converged: fit.converged,
      confidenceLevel: level,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The fit                                   */
/* -------------------------------------------------------------------------- */

interface IrlsResult {
  beta: Vector;
  standardErrors: Vector;
  fitted: Vector;
  logLikelihood: number;
  iterations: number;
  converged: boolean;
}

/**
 * Iteratively reweighted least squares.
 *
 * Each step forms a weighted linear problem whose solution is the Newton update
 * for the log-likelihood, and solves it with the same QR routine the linear
 * model uses. Weights are p(1−p), largest where the model is least certain,
 * which is what makes the method behave as it approaches the fit.
 *
 * Starting from all-zero coefficients means every probability begins at one
 * half and every weight at its maximum, which is both a neutral start and the
 * best-conditioned one.
 */
function fitIrls(design: Matrix, y: number[], p: number, n: number): IrlsResult {
  let beta: Vector = new Array<number>(p).fill(0);
  let logLikelihood = -Infinity;
  let converged = false;
  let iterations = 0;

  let fitted: Vector = new Array<number>(n).fill(0.5);
  let weights: Vector = new Array<number>(n).fill(0.25);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    iterations = iteration;

    /* Linear predictor, then probabilities. */
    const eta = design.map((row) =>
      row.reduce((sum, value, j) => sum + value * (beta[j] as number), 0),
    );

    fitted = eta.map(logistic);

    /*
     * Weights floored away from zero. A fitted probability of exactly 0 or 1
     * gives a weight of 0, and the weighted design matrix loses that row
     * entirely — which is how a separated model becomes a singular one and
     * fails with an error about linear algebra rather than about separation.
     */
    weights = fitted.map((probability) => Math.max(probability * (1 - probability), 1e-10));

    /*
     * The working response: the current linear predictor plus the scaled
     * residual. Regressing this on the design with these weights is exactly the
     * Newton step, which is what makes the whole method a sequence of ordinary
     * least-squares solves.
     */
    const working = eta.map(
      (value, i) => value + ((y[i] as number) - (fitted[i] as number)) / (weights[i] as number),
    );

    /* Weighting is applied by scaling rows, so the existing QR needs no changes. */
    const sqrtWeights = weights.map(Math.sqrt);
    const weightedDesign: Matrix = design.map((row, i) =>
      row.map((value) => value * (sqrtWeights[i] as number)),
    );
    const weightedResponse = working.map((value, i) => value * (sqrtWeights[i] as number));

    const { r, qty, diagonal } = qrDecompose(weightedDesign, weightedResponse);

    if (diagonal.some((value) => Math.abs(value) < 1e-10)) {
      throw new LogisticError('analysis.logistic.error.singular');
    }

    beta = backSubstitute(r, qty);

    /* Convergence on the log-likelihood rather than on the coefficients. */
    const nextEta = design.map((row) =>
      row.reduce((sum, value, j) => sum + value * (beta[j] as number), 0),
    );
    const nextFitted = nextEta.map(logistic);
    const nextLogLikelihood = logLikelihoodOf(y, nextFitted);

    if (Math.abs(nextLogLikelihood - logLikelihood) < TOLERANCE) {
      logLikelihood = nextLogLikelihood;
      fitted = nextFitted;
      converged = true;
      break;
    }

    logLikelihood = nextLogLikelihood;
    fitted = nextFitted;
  }

  /*
   * Standard errors from the inverse of the information matrix, obtained from
   * the final R rather than by inverting XᵀWX directly — the same reason the
   * linear model uses QR, and the same benefit.
   */
  const sqrtWeights = weights.map(Math.sqrt);
  const weightedDesign: Matrix = design.map((row, i) =>
    row.map((value) => value * (sqrtWeights[i] as number)),
  );
  const { r } = qrDecompose(
    weightedDesign,
    new Array<number>(n).fill(0),
  );

  const standardErrors = standardErrorsFromR(r, p);

  return { beta, standardErrors, fitted, logLikelihood, iterations, converged };
}

/**
 * The diagonal of (RᵀR)⁻¹, which gives the coefficient variances.
 *
 * The system to solve is Rᵀz = eⱼ, not Rz = eⱼ, and the difference is not
 * cosmetic. (RᵀR)⁻¹ = R⁻¹R⁻ᵀ, so its jth diagonal element is the squared norm
 * of the jth column of R⁻¹ — obtained by forward substitution on the transpose,
 * since Rᵀ is lower-triangular.
 *
 * Solving the untransposed system instead produced coefficients that matched
 * statsmodels to ten decimal places alongside standard errors that were wrong
 * by a factor of five, which turned a p-value of .0006 into .94. A fit can be
 * exactly right and its inference entirely wrong, and only a reference
 * comparison shows it.
 */
function standardErrorsFromR(r: Matrix, p: number): Vector {
  const errors: number[] = [];

  for (let j = 0; j < p; j += 1) {
    /* Forward substitution: Rᵀ is lower-triangular, so solve top-down. */
    const z = new Array<number>(p).fill(0);

    for (let i = 0; i < p; i += 1) {
      let sum = i === j ? 1 : 0;
      for (let k = 0; k < i; k += 1) {
        sum -= ((r[k] as number[])[i] as number) * (z[k] as number);
      }
      const pivot = (r[i] as number[])[i] as number;
      z[i] = Math.abs(pivot) < 1e-12 ? 0 : sum / pivot;
    }

    const variance = z.reduce((sum, value) => sum + value * value, 0);
    errors.push(Math.sqrt(Math.max(0, variance)));
  }

  return errors;
}

/**
 * The logistic function, guarded against overflow.
 *
 * `Math.exp(800)` is Infinity, and the naive form then divides Infinity by
 * Infinity to produce NaN — which propagates silently through the rest of the
 * fit. Clamping the linear predictor costs nothing: beyond ±700 the probability
 * is 0 or 1 to every digit a double can hold.
 */
function logistic(eta: number): number {
  if (eta > 700) return 1;
  if (eta < -700) return 0;
  return 1 / (1 + Math.exp(-eta));
}

function logLikelihoodOf(y: number[], fitted: Vector): number {
  let total = 0;

  for (let i = 0; i < y.length; i += 1) {
    /* Clamped: log(0) is -Infinity, and a perfectly fitted point would produce it. */
    const probability = Math.min(1 - 1e-15, Math.max(1e-15, fitted[i] as number));
    total += (y[i] as number) * Math.log(probability) + (1 - (y[i] as number)) * Math.log(1 - probability);
  }

  return total;
}

/** The standard-normal quantile, by the Beasley–Springer–Moro approximation. */
function zQuantile(p: number): number {
  if (p <= 0 || p >= 1) return 0;

  /* Bisection on the survival function: slower than a rational approximation and
     exact to the tolerance asked for, which matters more for an interval bound. */
  let low = -10;
  let high = 10;

  for (let i = 0; i < 200; i += 1) {
    const middle = (low + high) / 2;
    if (1 - normalSf(middle) < p) low = middle;
    else high = middle;
  }

  return (low + high) / 2;
}

function bandForPseudoR2(value: number): 'negligible' | 'small' | 'medium' | 'large' {
  if (value < 0.05) return 'negligible';
  if (value < 0.15) return 'small';
  if (value < 0.3) return 'medium';
  return 'large';
}
