/**
 * Confirmatory factor analysis — the measurement half of CB-SEM.
 *
 * Where PLS asks "do these items hang together and do these constructs
 * relate", CB-SEM asks a stricter question: **could the covariance matrix we
 * observed have been produced by the model we specified?** It estimates the
 * parameters that make the model-implied covariance matrix as close as possible
 * to the observed one, and then reports how close that is. A model can fit its
 * data well by that standard or be rejected by it — which PLS has no way to say.
 *
 * That difference is why researchers are asked for both, and why building this
 * is not duplicating PLS. It is also why the fit indices matter more here than
 * any single coefficient: χ², CFI, TLI, RMSEA and SRMR are what a reviewer
 * looks at first, and a model with beautiful loadings and an RMSEA of 0.14 is
 * not a model.
 *
 * **Estimated by maximum likelihood**, minimising the standard discrepancy
 * function
 *
 *   F = log|Σ| + tr(S Σ⁻¹) − log|S| − p
 *
 * where S is observed and Σ is model-implied. There is no closed form, so the
 * parameters are found by iterative descent — the same situation as logistic
 * regression, solved the same way.
 *
 * **Assumes multivariate normality and continuous indicators.** That assumption
 * is real and is stated to the researcher rather than buried: Likert data with
 * five points violates it, mildly at five and seriously at three, and the
 * honest response for badly non-normal data is PLS rather than a CB-SEM run
 * with a caveat nobody reads.
 *
 * **Validated against lavaan** (0.6-17; `likelihood = "wishart"`,
 * `information = "expected"`, marker-variable identification) on the
 * Holzinger & Swineford (1939) data and a simulated survey — estimates,
 * standard errors, χ², CFI, TLI, RMSEA and SRMR. The reference outputs are
 * committed under `evals/fixtures/references/` and checked on every run of
 * the analysis suite. χ² is (N − 1)·F, the Wishart convention AMOS uses.
 */

import { chiSquareSf, normalSf } from '../../distributions';
import { mean, pearson, standardDeviation } from '../../stats-core';

import type { LatentConstruct, PlsModel } from '../pls/schema';

/** Below this the optimiser has converged. */
const CONVERGENCE = 1e-7;
const MAX_ITERATIONS = 500;
/** Cases per estimated parameter, below which estimates are unstable. */
const CASES_PER_PARAMETER = 5;
/** Every CB-SEM text gives this as the floor, whatever the model size. */
const MIN_CASES = 100;

export class CbSemError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'CbSemError';
  }
}

export interface CbSemLoading {
  construct: string;
  indicator: string;
  /** Unstandardised, on the indicator's own scale. */
  estimate: number;
  standardError: number;
  /** estimate / standardError, judged against 1.96. */
  zValue: number;
  pValue: number;
  /** The correlation between indicator and factor — what is usually reported. */
  standardised: number;
  /** Residual variance: the part of the indicator the factor does not explain. */
  residualVariance: number;
  /** Squared standardised loading — the part it does. */
  rSquared: number;
  /** True for the indicator whose loading was fixed to set the factor's scale. */
  isReference: boolean;
}

export interface FitIndices {
  /**
   * The likelihood-ratio χ², and the one index almost nobody should read alone.
   *
   * It tests exact fit, which no model of real data achieves, and it grows with
   * sample size — so a good model rejected at n = 1000 and a poor one accepted
   * at n = 80 are both routine. Reported because it is required, and reported
   * alongside its degrees of freedom and the ratio that partially corrects for
   * sample size.
   */
  chiSquare: number;
  df: number;
  pValue: number;
  /** χ²/df — under 3 is the usual rule, under 5 the lenient one. */
  normedChiSquare: number;
  /** Comparative fit index, against the null model. Above 0.90, ideally 0.95. */
  cfi: number;
  /** Tucker–Lewis. Penalises complexity, so it can exceed 1 or fall below 0. */
  tli: number;
  /** Root mean square error of approximation. Below 0.08, ideally 0.06. */
  rmsea: number;
  /** Standardised root mean square residual. Below 0.08. */
  srmr: number;
  /** Whether the model would pass a conventional review on these numbers. */
  verdict: 'good' | 'acceptable' | 'poor';
}

export interface CbSemResult {
  loadings: CbSemLoading[];
  /** Correlations between the latent factors, with their significance. */
  factorCorrelations: {
    first: string;
    second: string;
    estimate: number;
    standardError: number;
    zValue: number;
    pValue: number;
  }[];
  fit: FitIndices;
  /** Composite reliability and AVE, computed from the standardised loadings. */
  reliability: { construct: string; compositeReliability: number; ave: number }[];
  n: number;
  rowsDropped: number;
  parameters: number;
  iterations: number;
  converged: boolean;
  /** Problems that do not stop estimation but bear on reading it. */
  warnings: { code: string; severity: 'info' | 'warning' | 'error'; params?: Record<string, string | number> }[];
}

/* -------------------------------------------------------------------------- */
/*                                 Estimation                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fits a confirmatory factor model.
 *
 * Takes the same model shape PLS uses, so a researcher can run both on one
 * specification and compare — which is the usual practice when a reviewer asks
 * for covariance-based confirmation of a PLS result.
 */
export function confirmatoryFactorAnalysis(
  model: PlsModel,
  data: Map<string, number[]>,
): CbSemResult {
  const constructs = model.constructs;
  const indicators = constructs.flatMap((construct) => construct.indicators);

  if (constructs.length < 1) throw new CbSemError('analysis.cbsem.error.noConstructs');

  /*
   * Every factor needs at least three indicators.
   *
   * With two, the factor is only identified because other factors in the model
   * constrain it; with one it is not identified at all. Three is the rule every
   * text gives, and a model that violates it produces numbers that look fine
   * and rest on nothing.
   */
  for (const construct of constructs) {
    if (construct.indicators.length < 3) {
      throw new CbSemError('analysis.cbsem.error.tooFewIndicators', {
        construct: construct.name,
        indicators: construct.indicators.length,
      });
    }
  }

  /* Listwise deletion: ML on a covariance matrix needs complete cases. */
  const rows = completeCases(indicators, data);
  const n = rows.length;

  const p = indicators.length;
  /* Loadings + residuals + factor covariances, minus one fixed loading each. */
  const parameters =
    p - constructs.length + p + (constructs.length * (constructs.length + 1)) / 2;

  if (n < MIN_CASES) {
    throw new CbSemError('analysis.cbsem.error.tooFewCases', { n, minimum: MIN_CASES });
  }

  const warnings: CbSemResult['warnings'] = [];

  if (n < parameters * CASES_PER_PARAMETER) {
    warnings.push({
      code: 'few-cases-per-parameter',
      severity: 'warning',
      params: {
        n,
        parameters,
        ratio: Number((n / parameters).toFixed(1)),
        recommended: CASES_PER_PARAMETER,
      },
    });
  }

  /* The observed covariance matrix, which is what the model is fitted to. */
  const columns = indicators.map((indicator) =>
    rows.map((row) => data.get(indicator)?.[row] as number),
  );

  for (const [index, values] of columns.entries()) {
    if (standardDeviation(values) === 0) {
      throw new CbSemError('analysis.cbsem.error.constantIndicator', {
        indicator: indicators[index] as string,
      });
    }
  }

  const observed = covarianceMatrix(columns);

  /*
   * Multivariate normality, checked crudely and reported honestly.
   *
   * A full test would be Mardia's coefficient. Univariate skew and kurtosis per
   * indicator catch the case that actually matters — Likert items with a floor
   * or ceiling — and are interpretable by the researcher, which Mardia's number
   * is not.
   */
  const nonNormal = columns
    .map((values, index) => ({ name: indicators[index] as string, ...shape(values) }))
    .filter((entry) => Math.abs(entry.skew) > 2 || Math.abs(entry.kurtosis) > 7);

  if (nonNormal.length > 0) {
    warnings.push({
      code: 'non-normal-indicators',
      severity: 'warning',
      params: {
        count: nonNormal.length,
        worst: nonNormal[0]?.name ?? '',
        skew: Number((nonNormal[0]?.skew ?? 0).toFixed(2)),
      },
    });
  }

  const layout = parameterLayout(constructs, indicators);

  /*
   * The pattern search finds the neighbourhood of the optimum reliably from
   * any start; Fisher scoring then lands on it exactly, which is what makes
   * the estimates and standard errors agree with a dedicated package.
   */
  const quick = estimateByML(constructs, indicators, observed, WARM_START_ITERATIONS);
  let refined = refineByScoring(constructs, indicators, observed, quick, layout);

  /* A start too rough for scoring to converge from gets the full search first. */
  if (!refined.scored) {
    const searched = estimateByML(constructs, indicators, observed);
    refined = refineByScoring(constructs, indicators, observed, searched, layout);
  }
  const fitted = refined.fitted;

  const df = (p * (p + 1)) / 2 - parameters;
  if (df < 0) {
    throw new CbSemError('analysis.cbsem.error.underIdentified', { df, parameters });
  }
  if (df === 0) {
    warnings.push({ code: 'just-identified', severity: 'warning', params: { parameters } });
  }

  if (!fitted.converged) {
    warnings.push({ code: 'did-not-converge', severity: 'error', params: { iterations: MAX_ITERATIONS } });
  }

  /*
   * A negative residual variance — a Heywood case.
   *
   * It means an indicator's error variance came out below zero, which is
   * impossible, and signals a misspecified model, too small a sample, or an
   * indicator that belongs elsewhere. Reported as an error rather than
   * silently clamped: a clamped Heywood case produces a model that reports
   * clean fit and is not identified.
   */
  /*
   * At or below zero. Scoring does not floor the residuals, so a negative one
   * shows up as negative, and one pinned at the search's lower bound is the
   * same improper solution approached from above.
   */
  const heywood = fitted.residuals.filter((value) => value <= HEYWOOD_BOUND);

  if (heywood.length > 0) {
    warnings.push({
      code: 'heywood-case',
      severity: 'error',
      params: { count: heywood.length },
    });
  }

  const implied = impliedCovariance(constructs, indicators, fitted);
  const fit = fitIndices(observed, implied, n, p, df);

  /*
   * Standard errors from the expected information matrix of the Wishart
   * likelihood: Cov(θ̂) = [ (n − 1)/2 · tr(Σ⁻¹ ∂Σ/∂θᵢ Σ⁻¹ ∂Σ/∂θⱼ) ]⁻¹. They
   * scale with 1/√(n − 1), as a standard error must.
   */
  const covariance = parameterCovariance(constructs, indicators, fitted, layout, n);

  return {
    loadings: buildLoadings(constructs, indicators, fitted, layout, covariance),
    factorCorrelations: buildFactorCorrelations(constructs, fitted, layout, covariance),
    fit,
    reliability: buildReliability(constructs, indicators, fitted),
    n,
    rowsDropped: (data.get(indicators[0] as string)?.length ?? 0) - n,
    parameters,
    iterations: fitted.iterations,
    converged: fitted.converged,
    warnings,
  };
}

/**
 * Pattern-search iterations before scoring takes over. Enough to leave the
 * arbitrary starting values; scoring then converges in a few dozen steps,
 * where the search alone would take seconds on a thirty-indicator model.
 */
const WARM_START_ITERATIONS = 15;

/** Residual variances at or below this are an improper (Heywood) solution. */
const HEYWOOD_BOUND = 1e-5;

/* -------------------------------------------------------------------------- */
/*                 Parameters, derivatives and the information                */
/* -------------------------------------------------------------------------- */

/**
 * Where each free parameter lives, in one fixed order: the free loadings (the
 * first indicator of each factor is fixed to 1), then every residual
 * variance, then the factor variances and covariances (upper triangle).
 */
interface ParameterLayout {
  /** Indicator index for each free loading. */
  loadings: number[];
  /** Factor of each indicator. */
  factorOf: number[];
  /** (a, b) with a ≤ b for each factor (co)variance. */
  phi: [number, number][];
  size: number;
}

function parameterLayout(constructs: LatentConstruct[], indicators: string[]): ParameterLayout {
  const index = new Map(indicators.map((name, position) => [name, position]));
  const factorOf: number[] = new Array(indicators.length).fill(0);
  const loadings: number[] = [];

  constructs.forEach((construct, factor) => {
    construct.indicators.forEach((indicator, position) => {
      const at = index.get(indicator) as number;
      factorOf[at] = factor;
      if (position > 0) loadings.push(at);
    });
  });

  const phi: [number, number][] = [];
  for (let a = 0; a < constructs.length; a += 1) {
    for (let b = a; b < constructs.length; b += 1) phi.push([a, b]);
  }

  return { loadings, factorOf, phi, size: loadings.length + indicators.length + phi.length };
}

function readParameters(fitted: FittedModel, layout: ParameterLayout): number[] {
  return [
    ...layout.loadings.map((at) => fitted.loadings[at] as number),
    ...fitted.residuals,
    ...layout.phi.map(([a, b]) => (fitted.factorCovariance[a] as number[])[b] as number),
  ];
}

function writeParameters(base: FittedModel, layout: ParameterLayout, theta: number[]): FittedModel {
  const loadings = [...base.loadings];
  layout.loadings.forEach((at, k) => (loadings[at] = theta[k] as number));

  const offset = layout.loadings.length;
  const residuals = base.residuals.map((_, i) => theta[offset + i] as number);

  const factorCovariance = base.factorCovariance.map((row) => [...row]);
  const phiOffset = offset + base.residuals.length;
  layout.phi.forEach(([a, b], k) => {
    const value = theta[phiOffset + k] as number;
    (factorCovariance[a] as number[])[b] = value;
    (factorCovariance[b] as number[])[a] = value;
  });

  return { ...base, loadings, residuals, factorCovariance };
}

/** ∂Σ/∂θ for every free parameter, as dense p × p matrices. */
function derivatives(fitted: FittedModel, layout: ParameterLayout): number[][][] {
  const p = fitted.loadings.length;
  const zero = () => Array.from({ length: p }, () => new Array(p).fill(0) as number[]);
  const phi = (a: number, b: number) => (fitted.factorCovariance[a] as number[])[b] as number;
  const result: number[][][] = [];

  /* Loading t on factor f: Σ gains e_t v' + v e_t', v_j = λ_j φ(f, f(j)). */
  for (const t of layout.loadings) {
    const d = zero();
    const f = layout.factorOf[t] as number;
    for (let j = 0; j < p; j += 1) {
      const v = (fitted.loadings[j] as number) * phi(f, layout.factorOf[j] as number);
      (d[t] as number[])[j] = ((d[t] as number[])[j] as number) + v;
      (d[j] as number[])[t] = ((d[j] as number[])[t] as number) + v;
    }
    result.push(d);
  }

  /* Residual variance t: e_t e_t'. */
  for (let t = 0; t < p; t += 1) {
    const d = zero();
    (d[t] as number[])[t] = 1;
    result.push(d);
  }

  /* Factor (co)variance φ(a, b): λλ' restricted to the indicators of a and b. */
  for (const [a, b] of layout.phi) {
    const d = zero();
    for (let i = 0; i < p; i += 1) {
      for (let j = 0; j < p; j += 1) {
        const fi = layout.factorOf[i];
        const fj = layout.factorOf[j];
        const hit = a === b ? fi === a && fj === a : (fi === a && fj === b) || (fi === b && fj === a);
        if (hit) (d[i] as number[])[j] = (fitted.loadings[i] as number) * (fitted.loadings[j] as number);
      }
    }
    result.push(d);
  }

  return result;
}

function multiply(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = (b[0] as number[]).length;
  const inner = b.length;
  const out: number[][] = Array.from({ length: n }, () => new Array(m).fill(0) as number[]);
  for (let i = 0; i < n; i += 1) {
    const row = a[i] as number[];
    const target = out[i] as number[];
    for (let k = 0; k < inner; k += 1) {
      const value = row[k] as number;
      if (value === 0) continue;
      const other = b[k] as number[];
      for (let j = 0; j < m; j += 1) target[j] = (target[j] as number) + value * (other[j] as number);
    }
  }
  return out;
}

/** tr(AB) without forming the product. */
function traceOfProduct(a: number[][], b: number[][]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const row = a[i] as number[];
    for (let k = 0; k < row.length; k += 1) sum += (row[k] as number) * ((b[k] as number[])[i] as number);
  }
  return sum;
}

/**
 * The gradient of F and its expected Hessian, both from Σ⁻¹∂Σ/∂θ:
 *   g_i = tr((I − Σ⁻¹S) Σ⁻¹ ∂ᵢΣ)       H_ij = tr(Σ⁻¹∂ᵢΣ Σ⁻¹∂ⱼΣ)
 */
function scoreAndInformation(
  observed: number[][],
  implied: number[][],
  derivs: number[][][],
): { gradient: number[]; information: number[][] } | null {
  const inverse = invert(implied);
  if (!inverse) return null;

  const p = observed.length;
  const weights = multiply(inverse, observed).map((row, i) => row.map((value, j) => (i === j ? 1 : 0) - value));
  const scaled = derivs.map((d) => multiply(inverse, d));

  const gradient = scaled.map((a) => traceOfProduct(weights, a));
  const information = scaled.map((a, i) => scaled.map((b, j) => (j < i ? 0 : traceOfProduct(a, b))));
  for (let i = 0; i < scaled.length; i += 1) {
    for (let j = 0; j < i; j += 1) (information[i] as number[])[j] = (information[j] as number[])[i] as number;
  }

  void p;
  return { gradient, information };
}

/**
 * Fisher scoring from the pattern-search solution.
 *
 * θ ← θ − H⁻¹g with step halving: a step is taken only if Σ stays positive
 * definite, the factor variances stay positive, and F does not increase. When
 * scoring cannot improve the start (a degenerate model) the start is kept, so
 * this can only ever make the fit better.
 */
function refineByScoring(
  constructs: LatentConstruct[],
  indicators: string[],
  observed: number[][],
  start: FittedModel,
  layout: ParameterLayout,
): { fitted: FittedModel; scored: boolean } {
  let current = start;
  let theta = readParameters(current, layout);
  let value = discrepancy(observed, impliedCovariance(constructs, indicators, current));
  /* Decided by scoring itself; the search's own verdict is only a fallback. */
  let converged = false;
  let iterations = start.iterations;

  for (let step = 0; step < 100; step += 1) {
    const implied = impliedCovariance(constructs, indicators, current);
    const parts = scoreAndInformation(observed, implied, derivatives(current, layout));
    if (!parts) break;

    const inverse = invert(parts.information);
    if (!inverse) break;

    const direction = inverse.map((row) => -row.reduce((sum, h, j) => sum + h * (parts.gradient[j] as number), 0));
    const largest = Math.max(...parts.gradient.map(Math.abs));
    if (largest < 1e-10) {
      converged = true;
      break;
    }

    let accepted = false;
    for (let scale = 1; scale > 1e-6; scale /= 2) {
      const candidateTheta = theta.map((x, i) => x + scale * (direction[i] as number));
      const candidate = writeParameters(current, layout, candidateTheta);
      const variancesPositive = constructs.every((_, f) => ((candidate.factorCovariance[f] as number[])[f] as number) > 0);
      if (!variancesPositive) continue;

      const next = discrepancy(observed, impliedCovariance(constructs, indicators, candidate));
      if (Number.isFinite(next) && next <= value + 1e-14) {
        const improvement = value - next;
        current = candidate;
        theta = candidateTheta;
        value = next;
        accepted = true;
        iterations += 1;
        if (improvement < 1e-13) converged = true;
        break;
      }
    }

    if (!accepted) {
      converged = largest < 1e-6;
      break;
    }
    if (converged) break;
  }

  return {
    fitted: { ...current, discrepancy: value, iterations, converged: converged || start.converged },
    scored: converged,
  };
}

/** Cov(θ̂) = 2/(n − 1) · H⁻¹, or null when the information is singular. */
function parameterCovariance(
  constructs: LatentConstruct[],
  indicators: string[],
  fitted: FittedModel,
  layout: ParameterLayout,
  n: number,
): number[][] | null {
  const implied = impliedCovariance(constructs, indicators, fitted);
  const parts = scoreAndInformation(implied, implied, derivatives(fitted, layout));
  if (!parts) return null;
  const inverse = invert(parts.information);
  if (!inverse) return null;
  const factor = 2 / (n - 1);
  return inverse.map((row) => row.map((value) => value * factor));
}

function varianceAt(covariance: number[][] | null, index: number): number {
  if (!covariance) return Number.NaN;
  const value = (covariance[index] as number[])[index] as number;
  return value > 0 ? value : Number.NaN;
}

/* -------------------------------------------------------------------------- */
/*                              The optimiser                                 */
/* -------------------------------------------------------------------------- */

interface FittedModel {
  /** One loading per indicator, in the order indicators appear. */
  loadings: number[];
  /** One residual variance per indicator. */
  residuals: number[];
  /** Factor covariance matrix, constructs × constructs. */
  factorCovariance: number[][];
  discrepancy: number;
  iterations: number;
  converged: boolean;
}

/**
 * Maximum likelihood by coordinate descent.
 *
 * Each parameter is adjusted in turn while the others are held, using a
 * numerical derivative and a step that shrinks when it overshoots. Slower than
 * the Newton–Raphson a dedicated package uses and far simpler; for models of
 * the size this product sees — a dozen indicators, three or four factors — it
 * converges in well under a second.
 *
 * The scale of each factor is set by fixing its first loading to 1. Without a
 * constraint the model is unidentified: multiplying every loading by two and
 * halving the factor variance fits identically, so there is no unique solution
 * to find.
 */
function estimateByML(
  constructs: LatentConstruct[],
  indicators: string[],
  observed: number[][],
  maxIterations = MAX_ITERATIONS,
): FittedModel {
  const indicatorIndex = new Map(indicators.map((name, index) => [name, index]));
  const factorOf = new Map<number, number>();
  const referenceOf = new Set<number>();

  constructs.forEach((construct, factor) => {
    construct.indicators.forEach((indicator, position) => {
      const index = indicatorIndex.get(indicator) as number;
      factorOf.set(index, factor);
      if (position === 0) referenceOf.add(index);
    });
  });

  /*
   * Starting values from the observed variances. A loading of one and a
   * residual of half the variance is close enough for descent to find its way,
   * and far better than zeros, which make the implied matrix singular on the
   * first evaluation.
   */
  const loadings = indicators.map((_, index) => (referenceOf.has(index) ? 1 : 0.7));
  const residuals = indicators.map((_, index) => (observed[index] as number[])[index] as number * 0.5);
  const factorCovariance = constructs.map((_, i) =>
    constructs.map((__, j) => (i === j ? 0.5 : 0.1)),
  );

  const current = (): FittedModel => ({
    loadings,
    residuals,
    factorCovariance,
    discrepancy: 0,
    iterations: 0,
    converged: false,
  });

  const evaluate = () =>
    discrepancy(observed, impliedCovariance(constructs, indicators, current()));

  let best = evaluate();
  let previous = Number.POSITIVE_INFINITY;
  let step = 0.1;
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations += 1) {
    let improved = false;

    /* Loadings, except the fixed reference of each factor. */
    for (let index = 0; index < loadings.length; index += 1) {
      if (referenceOf.has(index)) continue;
      improved = adjust(loadings, index, step, evaluate, () => best, (value) => (best = value)) || improved;
    }

    /* Residual variances, kept positive: a negative one is not a variance. */
    for (let index = 0; index < residuals.length; index += 1) {
      improved =
        adjust(residuals, index, step, evaluate, () => best, (value) => (best = value), 1e-6) ||
        improved;
    }

    /* Factor variances and covariances, symmetric by construction. */
    for (let i = 0; i < constructs.length; i += 1) {
      for (let j = i; j < constructs.length; j += 1) {
        const before = (factorCovariance[i] as number[])[j] as number;

        for (const direction of [step, -step]) {
          const candidate = before + direction;
          if (i === j && candidate <= 1e-6) continue;

          (factorCovariance[i] as number[])[j] = candidate;
          (factorCovariance[j] as number[])[i] = candidate;

          const value = evaluate();

          if (Number.isFinite(value) && value < best - 1e-12) {
            best = value;
            improved = true;
            break;
          }

          (factorCovariance[i] as number[])[j] = before;
          (factorCovariance[j] as number[])[i] = before;
        }
      }
    }

    if (!improved) {
      /*
       * No parameter improved at this step size. Halving it and continuing is
       * what turns a coarse search into a precise one; when the step is below
       * the convergence threshold there is nothing left to find.
       */
      step /= 2;
      if (step < CONVERGENCE) {
        converged = true;
        iterations += 1;
        break;
      }
    } else {
      /*
       * Progress was made, so the discrepancy is checked against the last
       * iteration rather than only the step size.
       *
       * A badly misspecified model can keep finding tiny improvements for the
       * full five hundred iterations and be reported as "did not converge",
       * when in fact the optimiser found the best fit available and the fit is
       * simply poor. Those are different findings and were being conflated: the
       * researcher needs to know the model does not fit, not that the software
       * gave up.
       */
      if (Math.abs(previous - best) < CONVERGENCE) {
        converged = true;
        iterations += 1;
        break;
      }
      previous = best;
    }
  }

  return { loadings, residuals, factorCovariance, discrepancy: best, iterations, converged };
}

/** Tries a parameter up and down; keeps whichever improves the fit. */
function adjust(
  values: number[],
  index: number,
  step: number,
  evaluate: () => number,
  getBest: () => number,
  setBest: (value: number) => void,
  floor?: number,
): boolean {
  const before = values[index] as number;

  for (const direction of [step, -step]) {
    const candidate = before + direction;
    if (floor !== undefined && candidate <= floor) continue;

    values[index] = candidate;
    const value = evaluate();

    if (Number.isFinite(value) && value < getBest() - 1e-12) {
      setBest(value);
      return true;
    }

    values[index] = before;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*                                 The model                                  */
/* -------------------------------------------------------------------------- */

/**
 * Σ = ΛΦΛ' + Θ — the covariance the model implies.
 *
 * Loadings times factor covariances times loadings, plus residual variances on
 * the diagonal. Comparing this against what was observed is the whole of
 * CB-SEM; everything else is a way of summarising the difference.
 */
function impliedCovariance(
  constructs: LatentConstruct[],
  indicators: string[],
  fitted: FittedModel,
): number[][] {
  const indicatorIndex = new Map(indicators.map((name, index) => [name, index]));
  const factorOf: number[] = new Array(indicators.length).fill(0);

  constructs.forEach((construct, factor) => {
    for (const indicator of construct.indicators) {
      factorOf[indicatorIndex.get(indicator) as number] = factor;
    }
  });

  const p = indicators.length;
  const implied: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));

  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < p; j += 1) {
      const phi = (fitted.factorCovariance[factorOf[i] as number] as number[])[
        factorOf[j] as number
      ] as number;

      let value = (fitted.loadings[i] as number) * phi * (fitted.loadings[j] as number);
      if (i === j) value += fitted.residuals[i] as number;

      (implied[i] as number[])[j] = value;
    }
  }

  return implied;
}

/**
 * The ML discrepancy function.
 *
 * Returns Infinity when Σ is not positive definite, which happens during the
 * search — the optimiser reads that as "worse" and steps back, which is exactly
 * the behaviour wanted. Throwing would abort a search that was about to
 * succeed.
 */
function discrepancy(observed: number[][], implied: number[][]): number {
  const p = observed.length;

  const impliedDet = determinant(implied);
  if (!Number.isFinite(impliedDet) || impliedDet <= 0) return Number.POSITIVE_INFINITY;

  const observedDet = determinant(observed);
  if (!Number.isFinite(observedDet) || observedDet <= 0) return Number.POSITIVE_INFINITY;

  const inverse = invert(implied);
  if (!inverse) return Number.POSITIVE_INFINITY;

  let trace = 0;
  for (let i = 0; i < p; i += 1) {
    for (let k = 0; k < p; k += 1) {
      trace += (observed[i] as number[])[k] as number * ((inverse[k] as number[])[i] as number);
    }
  }

  return Math.log(impliedDet) + trace - Math.log(observedDet) - p;
}

/* -------------------------------------------------------------------------- */
/*                                Fit indices                                 */
/* -------------------------------------------------------------------------- */

function fitIndices(
  observed: number[][],
  implied: number[][],
  n: number,
  p: number,
  df: number,
): FitIndices {
  const f = discrepancy(observed, implied);
  const chiSquare = Math.max(0, (n - 1) * f);

  /*
   * The null model: every indicator independent, variances free.
   *
   * CFI and TLI are both "how far from the null model toward perfect fit", so
   * they need a null χ² to measure against. For this model the ML solution is
   * closed-form — Σ = diag(S) — so no refitting is needed.
   */
  const nullChiSquare = nullModelChiSquare(observed, n, p);
  const nullDf = (p * (p - 1)) / 2;

  const delta = Math.max(0, chiSquare - df);
  const nullDelta = Math.max(0, nullChiSquare - nullDf, delta);

  /* As lavaan: a just-identified model (df = 0) fits exactly; CFI and TLI are 1, RMSEA 0. */
  const cfi = nullDelta > 0 ? 1 - delta / nullDelta : 1;

  const tli =
    nullDf > 0 && df > 0 && nullChiSquare / nullDf !== 1
      ? (nullChiSquare / nullDf - chiSquare / df) / (nullChiSquare / nullDf - 1)
      : 1;

  const rmsea = df > 0 ? Math.sqrt(Math.max(0, (chiSquare - df) / (df * (n - 1)))) : 0;

  /* SRMR: the average standardised residual, which is read directly. */
  let sum = 0;
  let count = 0;

  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      const sObserved = (observed[i] as number[])[j] as number;
      const sImplied = (implied[i] as number[])[j] as number;
      const scale = Math.sqrt(
        ((observed[i] as number[])[i] as number) * ((observed[j] as number[])[j] as number),
      );

      if (scale > 0) {
        sum += ((sObserved - sImplied) / scale) ** 2;
        count += 1;
      }
    }
  }

  const srmr = count > 0 ? Math.sqrt(sum / count) : 0;

  /*
   * The verdict combines the indices rather than reading one.
   *
   * Any single index can be flattered by sample size or model complexity, and
   * the convention every reviewer applies is that several must agree. A model
   * passing on CFI alone is not a model that passes.
   */
  const good = cfi >= 0.95 && rmsea <= 0.06 && srmr <= 0.08;
  const acceptable = cfi >= 0.9 && rmsea <= 0.08 && srmr <= 0.1;

  return {
    chiSquare,
    df,
    pValue: df > 0 ? chiSquareSf(chiSquare, df) : Number.NaN,
    normedChiSquare: df > 0 ? chiSquare / df : Number.NaN,
    cfi: Math.min(1, Math.max(0, cfi)),
    tli: Math.min(1, tli),
    rmsea,
    srmr,
    verdict: good ? 'good' : acceptable ? 'acceptable' : 'poor',
  };
}

/**
 * χ² for the model where every indicator is independent of every other.
 *
 * Its ML solution is Σ = diag(S), so F reduces to −ln|R| with R the observed
 * correlation matrix: χ²₀ = (n − 1)·(Σ ln sᵢᵢ − ln|S|). This used to sum
 * −ln(1 − r²) over pairs, which overstates χ²₀ whenever the items correlate
 * with each other — as a measurement model's items do by design — and so
 * inflated CFI and TLI (0.953 against the correct 0.931 on the Holzinger &
 * Swineford data).
 */
function nullModelChiSquare(observed: number[][], n: number, p: number): number {
  const logDet = Math.log(determinant(observed));
  if (!Number.isFinite(logDet)) return Number.NaN;

  let logDiagonal = 0;
  for (let i = 0; i < p; i += 1) logDiagonal += Math.log((observed[i] as number[])[i] as number);

  return Math.max(0, (n - 1) * (logDiagonal - logDet));
}

/* -------------------------------------------------------------------------- */
/*                                  Reporting                                 */
/* -------------------------------------------------------------------------- */

function buildLoadings(
  constructs: LatentConstruct[],
  indicators: string[],
  fitted: FittedModel,
  layout: ParameterLayout,
  covariance: number[][] | null,
): CbSemLoading[] {
  const indicatorIndex = new Map(indicators.map((name, index) => [name, index]));
  const result: CbSemLoading[] = [];

  constructs.forEach((construct, factor) => {
    const factorVariance = (fitted.factorCovariance[factor] as number[])[factor] as number;

    construct.indicators.forEach((indicator, position) => {
      const index = indicatorIndex.get(indicator) as number;
      const loading = fitted.loadings[index] as number;
      const residual = fitted.residuals[index] as number;
      /*
       * The model-implied variance λ²φ + θ, as lavaan's std.all uses — not the
       * observed variance, which gives a different number whenever the model
       * does not reproduce that variance exactly (P1-C audit).
       */
      const totalVariance = loading * loading * factorVariance + residual;

      /*
       * The standardised loading: the correlation between the indicator and its
       * factor. What every paper reports, and what the 0.7 threshold refers to.
       */
      const standardised =
        totalVariance > 0 ? (loading * Math.sqrt(factorVariance)) / Math.sqrt(totalVariance) : 0;

      /*
       * The reference loading is fixed to 1 to set the factor's scale, so it has
       * no standard error and no test — the same as AMOS and lavaan report.
       */
      const isReference = position === 0;
      const standardError = isReference
        ? 0
        : Math.sqrt(varianceAt(covariance, layout.loadings.indexOf(index)));
      const z = isReference || !(standardError > 0) ? Number.NaN : loading / standardError;

      result.push({
        construct: construct.name,
        indicator,
        estimate: loading,
        standardError,
        zValue: z,
        pValue: Number.isFinite(z) ? 2 * normalSf(Math.abs(z)) : Number.NaN,
        standardised,
        residualVariance: residual,
        rSquared: standardised ** 2,
        isReference,
      });
    });
  });

  return result;
}

/**
 * Factor correlations, with standard errors by the delta method.
 *
 * r = φ_ab / √(φ_aa φ_bb), so its variance comes from the joint covariance of
 * the three estimates. The previous 1/√(n − 3) is the standard error of an
 * *observed* correlation and ignores that these are between latent factors
 * estimated with error.
 */
function buildFactorCorrelations(
  constructs: LatentConstruct[],
  fitted: FittedModel,
  layout: ParameterLayout,
  covariance: number[][] | null,
): CbSemResult['factorCorrelations'] {
  const result: CbSemResult['factorCorrelations'] = [];
  const offset = layout.loadings.length + fitted.residuals.length;
  const at = (a: number, b: number) =>
    offset + layout.phi.findIndex(([x, y]) => (x === Math.min(a, b) && y === Math.max(a, b)));

  for (let i = 0; i < constructs.length; i += 1) {
    for (let j = i + 1; j < constructs.length; j += 1) {
      const covarianceIJ = (fitted.factorCovariance[i] as number[])[j] as number;
      const varianceI = (fitted.factorCovariance[i] as number[])[i] as number;
      const varianceJ = (fitted.factorCovariance[j] as number[])[j] as number;

      const scale = Math.sqrt(varianceI * varianceJ);
      const r = scale > 0 ? covarianceIJ / scale : 0;

      let standardError = Number.NaN;
      if (covariance && scale > 0) {
        const indices = [at(i, j), at(i, i), at(j, j)];
        const gradient = [1 / scale, -r / (2 * varianceI), -r / (2 * varianceJ)];
        let variance = 0;
        for (let x = 0; x < 3; x += 1) {
          for (let y = 0; y < 3; y += 1) {
            variance +=
              (gradient[x] as number) *
              (gradient[y] as number) *
              ((covariance[indices[x] as number] as number[])[indices[y] as number] as number);
          }
        }
        standardError = variance > 0 ? Math.sqrt(variance) : Number.NaN;
      }

      const z = standardError > 0 ? r / standardError : Number.NaN;

      result.push({
        first: constructs[i]?.name as string,
        second: constructs[j]?.name as string,
        estimate: r,
        standardError,
        zValue: z,
        pValue: Number.isFinite(z) ? 2 * normalSf(Math.abs(z)) : Number.NaN,
      });
    }
  }

  return result;
}

function buildReliability(
  constructs: LatentConstruct[],
  indicators: string[],
  fitted: FittedModel,
): CbSemResult['reliability'] {
  const indicatorIndex = new Map(indicators.map((name, index) => [name, index]));

  return constructs.map((construct, factor) => {
    const factorVariance = (fitted.factorCovariance[factor] as number[])[factor] as number;

    const standardised = construct.indicators.map((indicator) => {
      const index = indicatorIndex.get(indicator) as number;
      /* Model-implied variance, consistent with the standardised loadings above. */
      const loading = fitted.loadings[index] as number;
      const total = loading * loading * factorVariance + (fitted.residuals[index] as number);
      return total > 0
        ? ((fitted.loadings[index] as number) * Math.sqrt(factorVariance)) / Math.sqrt(total)
        : 0;
    });

    const sumLoadings = standardised.reduce((total, value) => total + value, 0);
    const sumErrors = standardised.reduce((total, value) => total + (1 - value ** 2), 0);

    return {
      construct: construct.name,
      compositeReliability: sumLoadings ** 2 / (sumLoadings ** 2 + sumErrors),
      ave: standardised.reduce((total, value) => total + value ** 2, 0) / standardised.length,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Numerics                                  */
/* -------------------------------------------------------------------------- */

function completeCases(indicators: string[], data: Map<string, number[]>): number[] {
  const length = data.get(indicators[0] as string)?.length ?? 0;
  const rows: number[] = [];

  for (let row = 0; row < length; row += 1) {
    let usable = true;
    for (const indicator of indicators) {
      const value = data.get(indicator)?.[row];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        usable = false;
        break;
      }
    }
    if (usable) rows.push(row);
  }

  return rows;
}

function covarianceMatrix(columns: number[][]): number[][] {
  const p = columns.length;
  const n = columns[0]?.length ?? 0;
  const means = columns.map((values) => mean(values));

  const matrix: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));

  for (let i = 0; i < p; i += 1) {
    for (let j = i; j < p; j += 1) {
      let sum = 0;
      for (let row = 0; row < n; row += 1) {
        sum +=
          ((columns[i] as number[])[row] as number - (means[i] as number)) *
          ((columns[j] as number[])[row] as number - (means[j] as number));
      }

      const value = sum / (n - 1);
      (matrix[i] as number[])[j] = value;
      (matrix[j] as number[])[i] = value;
    }
  }

  return matrix;
}

/** Determinant by LU decomposition with partial pivoting. */
function determinant(matrix: number[][]): number {
  const size = matrix.length;
  const a = matrix.map((row) => [...row]);
  let result = 1;

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs((a[row] as number[])[column] as number) > Math.abs((a[pivot] as number[])[column] as number)) {
        pivot = row;
      }
    }

    if (Math.abs((a[pivot] as number[])[column] as number) < 1e-14) return 0;

    if (pivot !== column) {
      [a[column], a[pivot]] = [a[pivot] as number[], a[column] as number[]];
      result = -result;
    }

    result *= (a[column] as number[])[column] as number;

    for (let row = column + 1; row < size; row += 1) {
      const factor = ((a[row] as number[])[column] as number) / ((a[column] as number[])[column] as number);
      for (let c = column; c < size; c += 1) {
        (a[row] as number[])[c] =
          ((a[row] as number[])[c] as number) - factor * ((a[column] as number[])[c] as number);
      }
    }
  }

  return result;
}

/** Inverse by Gauss–Jordan. Null when singular. */
function invert(matrix: number[][]): number[][] | null {
  const size = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs((a[row] as number[])[column] as number) > Math.abs((a[pivot] as number[])[column] as number)) {
        pivot = row;
      }
    }

    if (Math.abs((a[pivot] as number[])[column] as number) < 1e-14) return null;

    [a[column], a[pivot]] = [a[pivot] as number[], a[column] as number[]];

    const diagonal = (a[column] as number[])[column] as number;
    for (let c = 0; c < 2 * size; c += 1) {
      (a[column] as number[])[c] = ((a[column] as number[])[c] as number) / diagonal;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = (a[row] as number[])[column] as number;
      for (let c = 0; c < 2 * size; c += 1) {
        (a[row] as number[])[c] =
          ((a[row] as number[])[c] as number) - factor * ((a[column] as number[])[c] as number);
      }
    }
  }

  return a.map((row) => row.slice(size));
}

/** Skew and excess kurtosis, for the normality warning. */
function shape(values: number[]): { skew: number; kurtosis: number } {
  const n = values.length;
  const centre = mean(values);
  const spread = standardDeviation(values);

  if (spread === 0) return { skew: 0, kurtosis: 0 };

  let third = 0;
  let fourth = 0;

  for (const value of values) {
    const z = (value - centre) / spread;
    third += z ** 3;
    fourth += z ** 4;
  }

  return { skew: third / n, kurtosis: fourth / n - 3 };
}

export { covarianceMatrix, discrepancy, impliedCovariance, MIN_CASES, CASES_PER_PARAMETER };
export { pearson };
