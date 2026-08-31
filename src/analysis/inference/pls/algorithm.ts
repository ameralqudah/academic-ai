/**
 * Partial least squares structural equation modelling — the algorithm.
 *
 * A researcher says "job satisfaction affects performance, and performance
 * affects loyalty". None of those three is a column in their file: each is a
 * *latent* variable, measured indirectly through several questionnaire items.
 * PLS-SEM estimates both halves of that at once — how well the items measure
 * each construct, and how strongly the constructs relate.
 *
 * It is the method management and marketing research reaches for, over CB-SEM,
 * because it works on smaller samples and assumes nothing about the
 * distribution of the data. What it gives up is a global fit statistic and the
 * ability to test a model against the data as a whole.
 *
 * **How the estimation works, since the code is otherwise opaque.** Latent
 * scores start as simple sums of their indicators. Then two steps alternate:
 * the *inner* estimation replaces each construct's score with a weighted
 * combination of the constructs it connects to, and the *outer* estimation
 * recomputes each indicator's weight against that improved score. Repeat until
 * the weights stop moving. It converges quickly — usually under ten iterations
 * — and the fixed point it converges to is the estimate.
 *
 * **Two measurement modes, and the difference is not cosmetic.** Reflective
 * indicators are *caused by* the construct: several questions about
 * satisfaction all reflect one underlying feeling, so they should correlate
 * highly and dropping one loses little. Formative indicators *cause* the
 * construct: price, location and range together form "store attractiveness",
 * they need not correlate, and dropping one removes part of the definition.
 * Applying reflective criteria to a formative construct is one of the most
 * common serious errors in published PLS work, so the mode is declared by the
 * researcher and every check branches on it.
 *
 * Validated against published benchmark results and mathematical properties —
 * not against SmartPLS, which has not been run on the same data.
 */

import { mean, pearson, standardDeviation } from '../../stats-core';

/* -------------------------------------------------------------------------- */
/*                                   Model                                    */
/* -------------------------------------------------------------------------- */

export type MeasurementMode = 'reflective' | 'formative';

export interface LatentConstruct {
  name: string;
  /** Column names measuring it. */
  indicators: string[];
  mode: MeasurementMode;
}

export interface StructuralPath {
  from: string;
  to: string;
}

export interface PlsModel {
  constructs: LatentConstruct[];
  paths: StructuralPath[];
}

export interface PlsOptions {
  maxIterations?: number;
  tolerance?: number;
  /**
   * How a construct's score is weighted by its neighbours during the inner
   * estimation.
   *
   * `path` is the default in every current text: it respects the direction of
   * the arrows, using regression coefficients for predecessors and correlations
   * for successors. `factorial` and `centroid` ignore direction, and centroid
   * uses only the sign of the correlation — which is why it fails on models
   * with weak paths.
   */
  innerWeighting?: 'path' | 'factorial' | 'centroid';
}

export class PlsError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'PlsError';
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Results                                   */
/* -------------------------------------------------------------------------- */

export interface OuterWeight {
  construct: string;
  indicator: string;
  /** The estimation weight, on the standardised scale. */
  weight: number;
  /**
   * The correlation between the indicator and its construct's score.
   *
   * This is what reflective criteria judge — a loading below 0.708 means the
   * construct explains less than half the indicator's variance. For formative
   * constructs the weight matters instead, and the loading is reported only as
   * context.
   */
  loading: number;
}

export interface PlsEstimate {
  /** Standardised scores, one column per construct. */
  scores: Map<string, number[]>;
  outer: OuterWeight[];
  /** Path coefficients, keyed `from→to`. */
  pathCoefficients: Map<string, number>;
  iterations: number;
  converged: boolean;
  n: number;
  /** Rows dropped for missing values on any modelled indicator. */
  rowsDropped: number;
}

/* -------------------------------------------------------------------------- */
/*                                 Validation                                 */
/* -------------------------------------------------------------------------- */

/**
 * Checks the model is coherent before any arithmetic happens.
 *
 * Every failure here is a specification error rather than a data problem, and
 * naming it precisely saves a researcher from reading a result that could never
 * have been valid. A model with a cycle, in particular, will happily produce
 * numbers — PLS iterates regardless — and those numbers mean nothing.
 */
export function validateModel(model: PlsModel, availableColumns: string[]): void {
  if (model.constructs.length < 2) {
    throw new PlsError('analysis.pls.error.tooFewConstructs', {
      constructs: model.constructs.length,
    });
  }

  if (model.paths.length === 0) {
    throw new PlsError('analysis.pls.error.noPaths');
  }

  const names = new Set<string>();
  const columns = new Set(availableColumns);
  const usedIndicators = new Map<string, string>();

  for (const construct of model.constructs) {
    if (names.has(construct.name)) {
      throw new PlsError('analysis.pls.error.duplicateConstruct', { construct: construct.name });
    }
    names.add(construct.name);

    if (construct.indicators.length === 0) {
      throw new PlsError('analysis.pls.error.constructWithoutIndicators', {
        construct: construct.name,
      });
    }

    /*
     * A single-indicator construct is legitimate — a single-item measure — but
     * it makes reliability and convergent validity undefined rather than poor,
     * so it is allowed and flagged later rather than refused here.
     */
    for (const indicator of construct.indicators) {
      if (!columns.has(indicator)) {
        throw new PlsError('analysis.pls.error.unknownIndicator', {
          indicator,
          construct: construct.name,
        });
      }

      /*
       * An indicator belonging to two constructs makes their scores partly the
       * same variable, which guarantees they will appear correlated and
       * destroys discriminant validity by construction.
       */
      const owner = usedIndicators.get(indicator);
      if (owner) {
        throw new PlsError('analysis.pls.error.sharedIndicator', {
          indicator,
          first: owner,
          second: construct.name,
        });
      }
      usedIndicators.set(indicator, construct.name);
    }
  }

  for (const path of model.paths) {
    if (!names.has(path.from)) {
      throw new PlsError('analysis.pls.error.unknownConstructInPath', { construct: path.from });
    }
    if (!names.has(path.to)) {
      throw new PlsError('analysis.pls.error.unknownConstructInPath', { construct: path.to });
    }
    if (path.from === path.to) {
      throw new PlsError('analysis.pls.error.selfPath', { construct: path.from });
    }
  }

  const cycle = findCycle(model);
  if (cycle) {
    throw new PlsError('analysis.pls.error.cyclicModel', { cycle: cycle.join(' → ') });
  }
}

/**
 * Finds a cycle in the path model, if there is one.
 *
 * PLS assumes a recursive model — the arrows must not lead back to where they
 * started. A cycle is not detected by the algorithm itself: it iterates, it
 * converges, and it returns coefficients for a model that cannot be interpreted
 * causally. Refusing is the only honest response.
 */
function findCycle(model: PlsModel): string[] | null {
  const successors = new Map<string, string[]>();
  for (const path of model.paths) {
    const list = successors.get(path.from);
    if (list) list.push(path.to);
    else successors.set(path.from, [path.to]);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  function walk(node: string): string[] | null {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    if (done.has(node)) return null;

    visiting.add(node);
    stack.push(node);

    for (const next of successors.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }

    visiting.delete(node);
    done.add(node);
    stack.pop();
    return null;
  }

  for (const construct of model.constructs) {
    const found = walk(construct.name);
    if (found) return found;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*                                 Estimation                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs the PLS algorithm.
 *
 * Takes the raw indicator columns and returns latent scores, outer weights and
 * path coefficients. Everything downstream — reliability, validity, effect
 * sizes, bootstrapping — is computed from this output rather than repeating the
 * estimation.
 */
export function estimatePls(
  model: PlsModel,
  data: Map<string, number[]>,
  options: PlsOptions = {},
): PlsEstimate {
  const maxIterations = options.maxIterations ?? 300;
  const tolerance = options.tolerance ?? 1e-7;
  const weighting = options.innerWeighting ?? 'path';

  const indicators = model.constructs.flatMap((construct) => construct.indicators);

  /*
   * Listwise deletion across every modelled indicator. PLS has no principled
   * way to use a partially observed case, and pairwise deletion would give
   * different constructs different samples — which makes the path coefficients
   * describe overlapping but different studies.
   */
  const rowCount = data.get(indicators[0] as string)?.length ?? 0;
  const keep: number[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    let complete = true;
    for (const indicator of indicators) {
      const value = data.get(indicator)?.[row];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        complete = false;
        break;
      }
    }
    if (complete) keep.push(row);
  }

  const n = keep.length;
  const parameters = model.constructs.length + model.paths.length;

  if (n < 30 || n < parameters * 5) {
    throw new PlsError('analysis.pls.error.tooFewCases', {
      n,
      minimum: Math.max(30, parameters * 5),
    });
  }

  /*
   * Standardised once, here. PLS operates on standardised variables throughout,
   * and doing it at the boundary means every later step — weights, loadings,
   * path coefficients — is on a comparable scale without anyone remembering to
   * rescale.
   */
  const standardised = new Map<string, number[]>();

  for (const indicator of indicators) {
    const raw = keep.map((row) => data.get(indicator)?.[row] as number);
    const centre = mean(raw);
    const spread = standardDeviation(raw);

    if (spread === 0 || !Number.isFinite(spread)) {
      throw new PlsError('analysis.pls.error.constantIndicator', { indicator });
    }

    standardised.set(
      indicator,
      raw.map((value) => (value - centre) / spread),
    );
  }

  /* Initial scores: the unweighted sum of each construct's indicators. */
  const weights = new Map<string, number[]>();
  for (const construct of model.constructs) {
    weights.set(construct.name, construct.indicators.map(() => 1));
  }

  let scores = computeScores(model, standardised, weights, n);
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations += 1) {
    /* Inner: rebuild each construct's score from its neighbours in the path model. */
    const innerScores = innerEstimation(model, scores, weighting, n);

    /* Outer: recompute indicator weights against the improved scores. */
    const nextWeights = new Map<string, number[]>();
    let maxChange = 0;

    for (const construct of model.constructs) {
      const target = innerScores.get(construct.name) as number[];
      const current = weights.get(construct.name) as number[];
      const updated: number[] = [];

      if (construct.mode === 'reflective') {
        /*
         * Mode A: each weight is the simple correlation of its indicator with
         * the construct score. The indicators are effects of the construct, so
         * each is judged on its own against it.
         */
        for (const indicator of construct.indicators) {
          updated.push(pearson(standardised.get(indicator) as number[], target));
        }
      } else {
        /*
         * Mode B: the weights are the coefficients of a multiple regression of
         * the construct score on all its indicators together. The indicators
         * jointly form the construct, so each is judged holding the others
         * constant.
         */
        const matrix = construct.indicators.map(
          (indicator) => standardised.get(indicator) as number[],
        );
        updated.push(...multipleRegressionWeights(matrix, target));
      }

      /* Scaled so the resulting score has unit variance. */
      const normaliser = scoreNorm(construct, standardised, updated, n);
      const scaled = normaliser > 0 ? updated.map((value) => value / normaliser) : updated;

      for (let i = 0; i < scaled.length; i += 1) {
        maxChange = Math.max(maxChange, Math.abs((scaled[i] as number) - (current[i] as number)));
      }

      nextWeights.set(construct.name, scaled);
    }

    weights.clear();
    for (const [name, value] of nextWeights) weights.set(name, value);

    scores = computeScores(model, standardised, weights, n);

    if (maxChange < tolerance) {
      converged = true;
      iterations += 1;
      break;
    }
  }

  /*
   * Loadings are computed once at the end from the final scores, for every
   * construct regardless of mode. For a reflective construct the loading is the
   * criterion; for a formative one it is context — a formative indicator with a
   * near-zero loading and a significant weight is still contributing, and
   * reporting both is what lets a reader see that.
   */
  const outer: OuterWeight[] = [];

  for (const construct of model.constructs) {
    const score = scores.get(construct.name) as number[];
    const constructWeights = weights.get(construct.name) as number[];

    construct.indicators.forEach((indicator, index) => {
      outer.push({
        construct: construct.name,
        indicator,
        weight: constructWeights[index] as number,
        loading: pearson(standardised.get(indicator) as number[], score),
      });
    });
  }

  const pathCoefficients = estimatePaths(model, scores);

  return {
    scores,
    outer,
    pathCoefficients,
    iterations,
    converged,
    n,
    rowsDropped: rowCount - n,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Estimation steps                              */
/* -------------------------------------------------------------------------- */

/** Latent scores from indicator values and current weights, standardised. */
function computeScores(
  model: PlsModel,
  standardised: Map<string, number[]>,
  weights: Map<string, number[]>,
  n: number,
): Map<string, number[]> {
  const scores = new Map<string, number[]>();

  for (const construct of model.constructs) {
    const constructWeights = weights.get(construct.name) as number[];
    const score = new Array<number>(n).fill(0);

    construct.indicators.forEach((indicator, index) => {
      const column = standardised.get(indicator) as number[];
      const weight = constructWeights[index] as number;
      for (let row = 0; row < n; row += 1) {
        score[row] = (score[row] as number) + weight * (column[row] as number);
      }
    });

    scores.set(construct.name, standardise(score));
  }

  return scores;
}

/**
 * The inner estimation: each construct re-expressed through its neighbours.
 *
 * Under the path scheme the direction of the arrow decides the weight — a
 * regression coefficient when the neighbour predicts this construct, a
 * correlation when it is predicted by it. That asymmetry is what makes the
 * scheme respect the model rather than treating every connection alike.
 */
function innerEstimation(
  model: PlsModel,
  scores: Map<string, number[]>,
  weighting: 'path' | 'factorial' | 'centroid',
  n: number,
): Map<string, number[]> {
  const inner = new Map<string, number[]>();

  for (const construct of model.constructs) {
    const combined = new Array<number>(n).fill(0);

    const predecessors = model.paths.filter((path) => path.to === construct.name);
    const successors = model.paths.filter((path) => path.from === construct.name);

    for (const path of [...predecessors, ...successors]) {
      const neighbour = path.from === construct.name ? path.to : path.from;
      const neighbourScore = scores.get(neighbour) as number[];
      const own = scores.get(construct.name) as number[];

      let weight: number;
      const correlation = pearson(own, neighbourScore);

      if (weighting === 'centroid') {
        weight = Math.sign(correlation);
      } else if (weighting === 'factorial') {
        weight = correlation;
      } else {
        /*
         * Path scheme. For a predecessor the weight is its regression
         * coefficient in predicting this construct; for a successor it is the
         * plain correlation. With one predecessor the two coincide, which is
         * why simple models give the same answer under any scheme.
         */
        weight = predecessors.includes(path)
          ? regressionCoefficient(model, scores, construct.name, path.from)
          : correlation;
      }

      for (let row = 0; row < n; row += 1) {
        combined[row] = (combined[row] as number) + weight * (neighbourScore[row] as number);
      }
    }

    inner.set(construct.name, standardise(combined));
  }

  return inner;
}

/** One predictor's coefficient in the regression of `target` on its predecessors. */
function regressionCoefficient(
  model: PlsModel,
  scores: Map<string, number[]>,
  target: string,
  predictor: string,
): number {
  const predecessors = model.paths
    .filter((path) => path.to === target)
    .map((path) => path.from);

  if (predecessors.length === 1) {
    return pearson(scores.get(target) as number[], scores.get(predictor) as number[]);
  }

  const matrix = predecessors.map((name) => scores.get(name) as number[]);
  const coefficients = multipleRegressionWeights(matrix, scores.get(target) as number[]);

  return coefficients[predecessors.indexOf(predictor)] ?? 0;
}

/** Path coefficients: each endogenous construct regressed on its predecessors. */
function estimatePaths(model: PlsModel, scores: Map<string, number[]>): Map<string, number> {
  const coefficients = new Map<string, number>();

  for (const construct of model.constructs) {
    const predecessors = model.paths
      .filter((path) => path.to === construct.name)
      .map((path) => path.from);

    if (predecessors.length === 0) continue;

    const matrix = predecessors.map((name) => scores.get(name) as number[]);
    const target = scores.get(construct.name) as number[];
    const betas = multipleRegressionWeights(matrix, target);

    predecessors.forEach((from, index) => {
      coefficients.set(`${from}→${construct.name}`, betas[index] ?? 0);
    });
  }

  return coefficients;
}

/* -------------------------------------------------------------------------- */
/*                                  Numerics                                  */
/* -------------------------------------------------------------------------- */

/**
 * Standardised regression coefficients, on already-standardised inputs.
 *
 * Solved through the correlation matrix by Gaussian elimination with partial
 * pivoting. The matrices here are tiny — a construct rarely has more than ten
 * indicators — so the QR machinery used for the main regression would be more
 * apparatus than the problem needs; pivoting is enough to keep it stable at
 * this size.
 */
function multipleRegressionWeights(predictors: number[][], target: number[]): number[] {
  const k = predictors.length;
  if (k === 0) return [];
  if (k === 1) return [pearson(predictors[0] as number[], target)];

  /* Correlation matrix of the predictors, and their correlations with the target. */
  const matrix: number[][] = [];
  const vector: number[] = [];

  for (let i = 0; i < k; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < k; j += 1) {
      row.push(i === j ? 1 : pearson(predictors[i] as number[], predictors[j] as number[]));
    }
    matrix.push(row);
    vector.push(pearson(predictors[i] as number[], target));
  }

  return solve(matrix, vector);
}

function solve(matrix: number[][], vector: number[]): number[] {
  const k = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i] as number]);

  for (let column = 0; column < k; column += 1) {
    /* Partial pivoting: the largest available pivot, for numerical stability. */
    let pivot = column;
    for (let row = column + 1; row < k; row += 1) {
      if (Math.abs((a[row] as number[])[column] as number) > Math.abs((a[pivot] as number[])[column] as number)) {
        pivot = row;
      }
    }

    if (Math.abs((a[pivot] as number[])[column] as number) < 1e-12) {
      /*
       * A singular correlation matrix means two indicators are the same
       * variable, or one is a linear combination of others. There is no unique
       * solution, and returning zeros would look like "no relationship".
       */
      throw new PlsError('analysis.pls.error.singularConstruct');
    }

    [a[column], a[pivot]] = [a[pivot] as number[], a[column] as number[]];

    for (let row = 0; row < k; row += 1) {
      if (row === column) continue;
      const factor = ((a[row] as number[])[column] as number) / ((a[column] as number[])[column] as number);
      for (let c = column; c <= k; c += 1) {
        (a[row] as number[])[c] =
          ((a[row] as number[])[c] as number) - factor * ((a[column] as number[])[c] as number);
      }
    }
  }

  return Array.from({ length: k }, (_, i) =>
    ((a[i] as number[])[k] as number) / ((a[i] as number[])[i] as number),
  );
}

/** The standard deviation the weighted composite would have, for normalising. */
function scoreNorm(
  construct: LatentConstruct,
  standardised: Map<string, number[]>,
  weights: number[],
  n: number,
): number {
  const composite = new Array<number>(n).fill(0);

  construct.indicators.forEach((indicator, index) => {
    const column = standardised.get(indicator) as number[];
    const weight = weights[index] as number;
    for (let row = 0; row < n; row += 1) {
      composite[row] = (composite[row] as number) + weight * (column[row] as number);
    }
  });

  return standardDeviation(composite);
}

function standardise(values: number[]): number[] {
  const centre = mean(values);
  const spread = standardDeviation(values);
  if (spread === 0 || !Number.isFinite(spread)) return values.map(() => 0);
  return values.map((value) => (value - centre) / spread);
}
