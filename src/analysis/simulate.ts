/**
 * Simulated respondent-level data that reproduces a paper's published
 * statistics.
 *
 * **What this is for, and what it is not.** A published paper carries its
 * summaries — sample size, means, standard deviations, reliabilities,
 * correlations, path coefficients — and almost never its raw responses. A
 * lecturer who wants students to practise the analysis the paper reports has
 * nothing to hand them. This builds a file of invented respondents whose
 * summaries match the published ones, so the practice run lands near the
 * paper's numbers.
 *
 * The rows are not the study's data, and no property of them is evidence about
 * anything. Everything produced here is marked as simulated — in the data (a
 * `_simulated` column on every row), in the file name, and in the stored row —
 * and the writing steps refuse to treat an analysis of it as a finding. The
 * marking is not an option of this module; there is no parameter that turns it
 * off.
 *
 * **Arithmetic only.** No model is involved in generating a single value: a
 * seeded generator, a Cholesky factor, and rounding to the response scale. The
 * same specification and seed give the same file, byte for byte, which is what
 * lets a lecturer hand a class one dataset and know what they will find in it.
 *
 * **Every assumption is recorded.** A paper that reports no loadings gets
 * assumed ones, and the report says so. Filling a gap silently would make the
 * comparison table claim a match with numbers the paper never published.
 */

import { leastSquares, type Matrix } from './linear-algebra';
import { mean, pearson, standardDeviation } from './stats-core';
import type { CellValue, Dataset } from './types';

/* -------------------------------------------------------------------------- */
/*                               Specification                                */
/* -------------------------------------------------------------------------- */

/** The column that marks every generated row. Travels with the file. */
export const SIMULATED_COLUMN = '_simulated';

/** Prefix of every generated file name. */
export const SIMULATED_PREFIX = 'SIMULATED_';

export const MAX_SIMULATED_ROWS = 5_000;
export const MAX_SIMULATED_ITEMS = 200;

export interface ConstructSpec {
  /** Short column-safe name, e.g. `PU`. */
  name: string;
  /** The name as the paper gives it. */
  label?: string;
  /** Number of indicators. */
  items: number;
  /** Published mean of the construct score, on the response scale. */
  mean?: number;
  /** Published standard deviation of the construct score. */
  sd?: number;
  /** Published standardised loadings, one per item. */
  loadings?: number[];
  /** Published Cronbach's alpha, used to derive loadings when none are given. */
  alpha?: number;
}

export interface SimulationSpec {
  n: number;
  scale: { min: number; max: number };
  constructs: ConstructSpec[];
  /** Published correlations between construct scores. */
  correlations?: { a: string; b: string; r: number }[];
  /** Published standardised path coefficients. */
  paths?: { from: string; to: string; beta: number }[];
  demographics?: { name: string; categories: { label: string; share: number }[] }[];
  seed: number;
}

export type AssumptionCode =
  /** The paper did not say how many items a construct has. */
  | 'items.assumed'
  | 'loadings.assumed'
  | 'loadings.fromAlpha'
  | 'mean.assumed'
  | 'sd.assumed'
  | 'correlation.assumedZero'
  | 'correlation.fromPaths'
  | 'correlation.capped'
  | 'matrix.shrunk'
  | 'paths.rescaled'
  | 'demographics.independent';

export interface Assumption {
  code: AssumptionCode;
  /** The construct, pair or variable it concerns. */
  subject: string;
  /** The value that was used. */
  value?: number;
}

export interface ComparisonRow {
  statistic: 'n' | 'mean' | 'sd' | 'alpha' | 'correlation' | 'path' | 'share';
  subject: string;
  /** Null when the paper did not publish it and the value was assumed. */
  published: number | null;
  simulated: number;
  difference: number | null;
}

export interface SimulationResult {
  dataset: Dataset;
  comparison: ComparisonRow[];
  assumptions: Assumption[];
  seed: number;
}

export class SimulationError extends Error {
  constructor(
    public readonly code:
      | 'simulation.error.noConstructs'
      | 'simulation.error.sampleSize'
      | 'simulation.error.scale'
      | 'simulation.error.tooManyItems'
      | 'simulation.error.cyclicPaths'
      | 'simulation.error.unknownConstruct',
    public readonly params: Record<string, string | number> = {},
  ) {
    super(code);
    this.name = 'SimulationError';
  }
}

/* -------------------------------------------------------------------------- */
/*                                Random source                               */
/* -------------------------------------------------------------------------- */

/**
 * A seeded generator.
 *
 * `Math.random` cannot be seeded, and an unseeded simulation cannot be handed
 * to thirty students with the promise that they all hold the same file.
 * Mulberry32 is small, fast and has no detectable structure at the sizes used
 * here; this is a teaching dataset, not a cryptographic key.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws by Box–Muller. */
function normalSource(random: () => number): () => number {
  let spare: number | null = null;

  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }

    let u = 0;
    while (u <= Number.EPSILON) u = random();
    const v = random();

    const radius = Math.sqrt(-2 * Math.log(u));
    spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  };
}

/* -------------------------------------------------------------------------- */
/*                               Matrix helpers                               */
/* -------------------------------------------------------------------------- */

/** Lower-triangular Cholesky factor, or null when the matrix is not positive definite. */
export function cholesky(a: Matrix): Matrix | null {
  const size = a.length;
  const l: Matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0));

  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = a[i]?.[j] ?? 0;

      for (let k = 0; k < j; k += 1) sum -= (l[i]?.[k] ?? 0) * (l[j]?.[k] ?? 0);

      if (i === j) {
        /* A pivot this small is a matrix that is singular in practice. */
        if (sum <= 1e-10) return null;
        (l[i] as number[])[j] = Math.sqrt(sum);
      } else {
        (l[i] as number[])[j] = sum / (l[j]?.[j] as number);
      }
    }
  }

  return l;
}

/**
 * The nearest usable correlation matrix, by shrinking towards independence.
 *
 * Published correlation tables are rounded to two decimals and sometimes pooled
 * from different subsamples, so a table that is not positive definite is a
 * normal thing to meet rather than an error in the paper. Shrinking towards the
 * identity in small steps changes every correlation by the same small
 * proportion, which keeps their order and sign — and the amount is reported.
 */
function makePositiveDefinite(matrix: Matrix): { matrix: Matrix; factor: Matrix; shrink: number } {
  for (let step = 0; step <= 50; step += 1) {
    const shrink = step * 0.02;

    const candidate = matrix.map((row, i) =>
      row.map((value, j) => (i === j ? 1 : value * (1 - shrink))),
    );

    const factor = cholesky(candidate);
    if (factor) return { matrix: candidate, factor, shrink };
  }

  /* Unreachable: at full shrinkage the candidate is the identity. */
  const size = matrix.length;
  const eye = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
  );

  return { matrix: eye, factor: eye, shrink: 1 };
}

/* -------------------------------------------------------------------------- */
/*                         From paths to correlations                         */
/* -------------------------------------------------------------------------- */

/** Constructs ordered so that every cause comes before its effects. */
function causalOrder(names: string[], paths: { from: string; to: string }[]): string[] {
  const incoming = new Map<string, Set<string>>();
  for (const name of names) incoming.set(name, new Set());
  for (const path of paths) incoming.get(path.to)?.add(path.from);

  const ordered: string[] = [];
  const remaining = new Set(names);

  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) =>
      [...(incoming.get(name) ?? [])].every((cause) => !remaining.has(cause)),
    );

    if (ready.length === 0) throw new SimulationError('simulation.error.cyclicPaths');

    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }

  return ordered;
}

/**
 * The correlation matrix a recursive path model implies.
 *
 * For a standardised outcome y = Σ βⱼxⱼ + e, the correlation of y with any
 * variable z that comes earlier is Σ βⱼ·r(xⱼ, z). Walking the constructs in
 * causal order fills the matrix one row at a time.
 *
 * Published correlations win where both exist: a correlation in a table was
 * observed, and one implied by the paths is a consequence of a model.
 */
function impliedCorrelations(
  names: string[],
  spec: SimulationSpec,
  assumptions: Assumption[],
): Matrix {
  const index = new Map(names.map((name, position) => [name, position]));
  const size = names.length;

  const known: (number | null)[][] = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 1 : null)),
  );

  for (const entry of spec.correlations ?? []) {
    const a = index.get(entry.a);
    const b = index.get(entry.b);
    if (a === undefined || b === undefined || a === b) continue;

    (known[a] as (number | null)[])[b] = entry.r;
    (known[b] as (number | null)[])[a] = entry.r;
  }

  const paths = (spec.paths ?? []).filter(
    (path) => index.has(path.from) && index.has(path.to) && path.from !== path.to,
  );

  const order = causalOrder(names, paths);
  const result: Matrix = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
  );

  const placed: number[] = [];

  for (const name of order) {
    const target = index.get(name) as number;
    const causes = paths.filter((path) => path.to === name);

    /*
     * Betas whose explained variance reaches one leave no room for an error
     * term, which no real outcome has. Scaled back to ninety per cent and
     * reported, rather than producing a variable that is an exact function of
     * its predictors.
     */
    let betas = causes.map((path) => ({ from: index.get(path.from) as number, beta: path.beta }));

    const explained = betas.reduce(
      (total, a) =>
        total + betas.reduce((inner, b) => inner + a.beta * b.beta * (result[a.from]?.[b.from] ?? 0), 0),
      0,
    );

    if (explained > 0.9) {
      const factor = Math.sqrt(0.9 / explained);
      betas = betas.map((entry) => ({ ...entry, beta: entry.beta * factor }));
      assumptions.push({ code: 'paths.rescaled', subject: name, value: round(factor, 3) });
    }

    for (const other of placed) {
      const published = known[target]?.[other];

      let value: number;

      if (published !== null && published !== undefined) {
        value = published;
      } else if (betas.length > 0) {
        value = betas.reduce((total, entry) => total + entry.beta * (result[entry.from]?.[other] ?? 0), 0);
        assumptions.push({
          code: 'correlation.fromPaths',
          subject: `${names[other]} ~ ${name}`,
          value: round(value, 3),
        });
      } else {
        value = 0;
        assumptions.push({ code: 'correlation.assumedZero', subject: `${names[other]} ~ ${name}` });
      }

      (result[target] as number[])[other] = value;
      (result[other] as number[])[target] = value;
    }

    placed.push(target);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*                                 Generation                                 */
/* -------------------------------------------------------------------------- */

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Loadings for one construct, and how they were arrived at. */
function loadingsFor(construct: ConstructSpec, assumptions: Assumption[]): number[] {
  const published = (construct.loadings ?? []).filter((value) => Number.isFinite(value));

  if (published.length === construct.items) {
    return published.map((value) => clamp(Math.abs(value), 0.2, 0.97));
  }

  /*
   * From alpha, assuming equal loadings: α = k·r̄ / (1 + (k − 1)·r̄) with
   * r̄ = λ², solved for λ. One item has no alpha, and gets the default.
   */
  if (construct.alpha !== undefined && construct.items > 1 && construct.alpha > 0 && construct.alpha < 1) {
    const k = construct.items;
    const average = construct.alpha / (k - construct.alpha * (k - 1));
    const loading = clamp(Math.sqrt(clamp(average, 0.04, 0.94)), 0.2, 0.97);

    assumptions.push({ code: 'loadings.fromAlpha', subject: construct.name, value: round(loading, 3) });
    return new Array<number>(k).fill(loading);
  }

  assumptions.push({ code: 'loadings.assumed', subject: construct.name, value: 0.75 });
  return new Array<number>(construct.items).fill(0.75);
}

/** Reliability of the mean of items with these loadings (coefficient omega). */
function compositeReliability(loadings: number[]): number {
  const total = loadings.reduce((sum, value) => sum + value, 0);
  const unique = loadings.reduce((sum, value) => sum + (1 - value * value), 0);
  return (total * total) / (total * total + unique);
}

function totalItemsOf(spec: SimulationSpec): number {
  return spec.constructs.reduce((sum, construct) => sum + construct.items, 0);
}

function validate(spec: SimulationSpec): void {
  if (spec.constructs.length === 0) throw new SimulationError('simulation.error.noConstructs');

  if (spec.constructs.some((construct) => !Number.isInteger(construct.items) || construct.items < 1)) {
    throw new SimulationError('simulation.error.noConstructs');
  }

  const totalItems = totalItemsOf(spec);
  if (totalItems > MAX_SIMULATED_ITEMS) {
    throw new SimulationError('simulation.error.tooManyItems', { limit: MAX_SIMULATED_ITEMS, found: totalItems });
  }

  const minimum = Math.max(10, spec.constructs.length + 2);
  if (!Number.isInteger(spec.n) || spec.n < minimum || spec.n > MAX_SIMULATED_ROWS) {
    throw new SimulationError('simulation.error.sampleSize', { min: minimum, max: MAX_SIMULATED_ROWS, found: spec.n });
  }

  if (
    !Number.isInteger(spec.scale.min) ||
    !Number.isInteger(spec.scale.max) ||
    spec.scale.max - spec.scale.min < 1 ||
    spec.scale.max - spec.scale.min > 100
  ) {
    throw new SimulationError('simulation.error.scale');
  }

  const names = new Set(spec.constructs.map((construct) => construct.name));

  for (const path of spec.paths ?? []) {
    for (const end of [path.from, path.to]) {
      if (!names.has(end)) throw new SimulationError('simulation.error.unknownConstruct', { name: end });
    }
  }
}

/**
 * Standard normal noise whose sample covariance is exactly the identity.
 *
 * Random draws have sampling error, so a sample of two hundred drawn from a
 * population with r = .45 shows .38 or .51. For a file meant to reproduce a
 * table that is the wrong behaviour. The draws are whitened — centred and
 * rotated so that, in this sample, every column has unit variance and no two
 * columns correlate. Structure imposed on them afterwards then appears in the
 * sample exactly, and the only differences left are the ones rounding to the
 * response scale introduces.
 *
 * Needs more rows than columns. With fewer, the sample covariance is singular
 * and the draws are returned centred but otherwise as they fell.
 */
function whitenedNoise(n: number, size: number, normal: () => number): Matrix {
  const raw: Matrix = Array.from({ length: n }, () => Array.from({ length: size }, () => normal()));

  for (let j = 0; j < size; j += 1) {
    let sum = 0;
    for (const row of raw) sum += row[j] as number;
    const centre = sum / n;
    for (const row of raw) row[j] = (row[j] as number) - centre;
  }

  if (n <= size + 1) return raw;

  const sample: Matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0));

  for (const row of raw) {
    for (let i = 0; i < size; i += 1) {
      const left = row[i] as number;
      const target = sample[i] as number[];
      for (let j = 0; j <= i; j += 1) target[j] = (target[j] as number) + left * (row[j] as number);
    }
  }

  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      const value = (sample[i]?.[j] as number) / (n - 1);
      (sample[i] as number[])[j] = value;
      (sample[j] as number[])[i] = value;
    }
  }

  const factor = cholesky(sample);
  if (!factor) return raw;

  /* Solve L·w = row by forward substitution, so that cov(w) = I. */
  return raw.map((row) => {
    const solved = new Array<number>(size).fill(0);

    for (let i = 0; i < size; i += 1) {
      let value = row[i] as number;
      const line = factor[i] as number[];
      for (let k = 0; k < i; k += 1) value -= (line[k] as number) * (solved[k] as number);
      solved[i] = value / (line[i] as number);
    }

    return solved;
  });
}

/**
 * Continuous item scores rounded onto the response scale, calibrated so the
 * construct score has the published mean and standard deviation.
 *
 * Rounding and clipping both pull a distribution towards the middle of the
 * scale, so placing the continuous scores at the target and rounding once
 * lands short. A few corrections of location and spread close the gap; the
 * continuous scores never change, so the result is still deterministic.
 */
function discretise(
  continuous: Matrix,
  target: { mean: number; sd: number },
  scale: { min: number; max: number },
): number[][] {
  let location = target.mean;
  let spread = target.sd;
  let best: number[][] = [];
  let bestError = Number.POSITIVE_INFINITY;

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const items = continuous.map((row) =>
      row.map((value) => clamp(Math.round(location + spread * value), scale.min, scale.max)),
    );

    const scores = items.map((row) => mean(row));
    const observedMean = mean(scores);
    const observedSd = standardDeviation(scores);

    const error = Math.abs(observedMean - target.mean) + Math.abs(observedSd - target.sd);

    if (error < bestError) {
      bestError = error;
      best = items;
    }

    if (error < 0.004 || observedSd === 0) break;

    location += target.mean - observedMean;
    spread *= clamp(target.sd / observedSd, 0.5, 2);
  }

  return best;
}

/** Category counts that add up to n exactly, by largest remainder. */
function quotas(shares: number[], n: number): number[] {
  const total = shares.reduce((sum, share) => sum + Math.max(0, share), 0) || 1;
  const exact = shares.map((share) => (Math.max(0, share) / total) * n);
  const counts = exact.map((value) => Math.floor(value));

  let remaining = n - counts.reduce((sum, count) => sum + count, 0);

  const byRemainder = exact
    .map((value, position) => ({ position, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);

  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    counts[entry.position] = (counts[entry.position] as number) + 1;
    remaining -= 1;
  }

  return counts;
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const copy = [...values];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }

  return copy;
}

/** Cronbach's alpha from item columns. */
function alphaOf(items: number[][]): number {
  const k = items[0]?.length ?? 0;
  if (k < 2) return Number.NaN;

  let itemVariance = 0;
  for (let j = 0; j < k; j += 1) {
    const sd = standardDeviation(items.map((row) => row[j] as number));
    itemVariance += sd * sd;
  }

  const totalSd = standardDeviation(items.map((row) => row.reduce((sum, value) => sum + value, 0)));
  const totalVariance = totalSd * totalSd;

  if (totalVariance === 0) return Number.NaN;
  return (k / (k - 1)) * (1 - itemVariance / totalVariance);
}

/**
 * Generates the dataset and the table comparing it with what was published.
 *
 * Pure: no clock, no I/O, no unseeded randomness.
 */
export function simulateDataset(spec: SimulationSpec, source = 'simulation'): SimulationResult {
  validate(spec);

  const assumptions: Assumption[] = [];
  const names = spec.constructs.map((construct) => construct.name);

  const random = seededRandom(spec.seed);
  const normal = normalSource(random);

  /* ---- 1. Loadings, as published or derived. ---- */
  let loadings = spec.constructs.map((construct) => loadingsFor(construct, assumptions));

  /* ---- 2. Correlations between construct scores, as published or implied. ---- */
  const scoreCorrelations = impliedCorrelations(names, spec, assumptions);

  /* ---- 3. Targets for each construct's score. ---- */
  const midpoint = (spec.scale.min + spec.scale.max) / 2;
  const range = spec.scale.max - spec.scale.min;

  const targets = spec.constructs.map((construct) => {
    let targetMean = construct.mean;
    let targetSd = construct.sd;

    if (targetMean === undefined || !Number.isFinite(targetMean)) {
      /* Slightly above the midpoint, where agreement scales usually sit. */
      targetMean = midpoint + range * 0.1;
      assumptions.push({ code: 'mean.assumed', subject: construct.name, value: round(targetMean, 2) });
    }

    if (targetSd === undefined || !Number.isFinite(targetSd) || targetSd <= 0) {
      targetSd = range * 0.2;
      assumptions.push({ code: 'sd.assumed', subject: construct.name, value: round(targetSd, 2) });
    }

    return { mean: clamp(targetMean, spec.scale.min, spec.scale.max), sd: targetSd };
  });

  /*
   * ---- 4. One set of noise, drawn once. ----
   *
   * A column per latent variable and a column per item error, whitened
   * together so the errors are uncorrelated with the latents and with each
   * other in this sample, not merely in expectation. Everything after this is
   * algebra on fixed numbers, which is what makes the calibration below
   * deterministic.
   */
  const constructCount = spec.constructs.length;
  const noise = whitenedNoise(spec.n, constructCount + totalItemsOf(spec), normal);

  const errorOffsets: number[] = [];
  spec.constructs.reduce((offset, construct) => {
    errorOffsets.push(offset);
    return offset + construct.items;
  }, constructCount);

  /*
   * A published correlation is between scores, and scores carry measurement
   * error, so the latent correlation that produces it is larger:
   * r_latent = r_scores / √(rel_a · rel_b). Skipping this would give a file
   * whose correlations are all weaker than the paper's by the same proportion.
   */
  const reliabilities = loadings.map((values) => compositeReliability(values));

  let latent: Matrix = scoreCorrelations.map((row, i) =>
    row.map((value, j) =>
      i === j ? 1 : value / Math.sqrt((reliabilities[i] as number) * (reliabilities[j] as number)),
    ),
  );

  const build = (latentTarget: Matrix, currentLoadings: number[][]) => {
    const capped: Matrix = latentTarget.map((row, i) =>
      row.map((value, j) => (i === j ? 1 : clamp(value, -0.95, 0.95))),
    );

    const usable = makePositiveDefinite(capped);

    const blocks = spec.constructs.map((_, position) => {
      const own = currentLoadings[position] as number[];
      const line = usable.factor[position] as number[];
      const offset = errorOffsets[position] as number;

      const continuous: Matrix = noise.map((row) => {
        let score = 0;
        for (let k = 0; k <= position; k += 1) score += (line[k] as number) * (row[k] as number);

        return own.map(
          (loading, item) => loading * score + Math.sqrt(1 - loading * loading) * (row[offset + item] as number),
        );
      });

      return discretise(continuous, targets[position] as { mean: number; sd: number }, spec.scale);
    });

    return { blocks, shrink: usable.shrink, capped: capped.some((row, i) => row.some((v, j) => v !== latentTarget[i]?.[j])) };
  };

  /*
   * ---- 4b. Calibration. ----
   *
   * Rounding a continuous score onto five points weakens every correlation it
   * takes part in, and lowers alpha, by an amount that depends on where the
   * mean sits on the scale. Rather than model that, it is measured: build the
   * file, compare the score correlations and alphas with the targets, scale
   * the latent correlations and the alpha-derived loadings by the shortfall,
   * and build again. Published loadings are never adjusted — they were
   * published.
   */
  let best = build(latent, loadings);
  let bestError = Number.POSITIVE_INFINITY;

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const attempt = iteration === 0 ? best : build(latent, loadings);
    const composite = attempt.blocks.map((block) => block.map((row) => mean(row)));

    let error = 0;
    const nextLatent: Matrix = latent.map((row) => [...row]);

    for (let i = 0; i < constructCount; i += 1) {
      for (let j = 0; j < i; j += 1) {
        const wanted = scoreCorrelations[i]?.[j] as number;
        const observed = pearson(composite[i] as number[], composite[j] as number[]);

        if (!Number.isFinite(observed)) continue;
        error = Math.max(error, Math.abs(observed - wanted));

        const current = latent[i]?.[j] as number;
        const adjusted =
          Math.abs(observed) > 0.02 && Math.sign(observed) === Math.sign(wanted)
            ? current * clamp(wanted / observed, 0.8, 1.25)
            : current + (wanted - observed);

        (nextLatent[i] as number[])[j] = adjusted;
        (nextLatent[j] as number[])[i] = adjusted;
      }
    }

    const nextLoadings = loadings.map((values, position) => {
      const construct = spec.constructs[position] as ConstructSpec;
      const k = construct.items;

      const derived = (construct.loadings ?? []).length !== k;
      if (!derived || construct.alpha === undefined || k < 2) return values;
      if (!(construct.alpha > 0 && construct.alpha < 1)) return values;

      const observed = alphaOf(attempt.blocks[position] as number[][]);
      if (!Number.isFinite(observed) || observed <= 0 || observed >= 1) return values;

      error = Math.max(error, Math.abs(observed - construct.alpha));

      const wantedAverage = construct.alpha / (k - construct.alpha * (k - 1));
      const observedAverage = observed / (k - observed * (k - 1));
      const factor = clamp(Math.sqrt(wantedAverage / observedAverage), 0.9, 1.1);

      return values.map((value) => clamp(value * factor, 0.2, 0.97));
    });

    if (error < bestError) {
      bestError = error;
      best = attempt;
    }

    if (error < 0.005) break;

    latent = nextLatent;
    loadings = nextLoadings;
  }

  if (best.capped) assumptions.push({ code: 'correlation.capped', subject: 'latent correlations', value: 0.95 });

  if (best.shrink > 0) {
    assumptions.push({ code: 'matrix.shrunk', subject: 'correlations', value: round(best.shrink, 2) });
  }

  const itemBlocks: number[][][] = best.blocks;

  /* ---- 5. Demographics: exact shares, unrelated to anything else. ---- */
  const demographics = (spec.demographics ?? [])
    .filter((variable) => variable.categories.length > 0)
    .map((variable) => {
      const counts = quotas(variable.categories.map((category) => category.share), spec.n);

      const values = variable.categories.flatMap((category, position) =>
        new Array<string>(counts[position] as number).fill(category.label),
      );

      return { name: variable.name, values: shuffle(values, random), counts };
    });

  if (demographics.length > 0) {
    assumptions.push({ code: 'demographics.independent', subject: demographics.map((d) => d.name).join(', ') });
  }

  /* ---- 6. The table. The marker is the first column of every row. ---- */
  const itemColumns = spec.constructs.flatMap((construct) =>
    Array.from({ length: construct.items }, (_, item) => `${construct.name}${item + 1}`),
  );

  const columns = [SIMULATED_COLUMN, 'respondent_id', ...demographics.map((d) => d.name), ...itemColumns];

  const rows: CellValue[][] = Array.from({ length: spec.n }, (_, respondent) => [
    1,
    respondent + 1,
    ...demographics.map((variable) => variable.values[respondent] ?? null),
    ...itemBlocks.flatMap((block) => block[respondent] as number[]),
  ]);

  /* ---- 7. What came out, beside what was published. ---- */
  const comparison: ComparisonRow[] = [
    { statistic: 'n', subject: 'N', published: spec.n, simulated: rows.length, difference: 0 },
  ];

  const compositeScores = itemBlocks.map((block) => block.map((row) => mean(row)));

  const compare = (
    statistic: ComparisonRow['statistic'],
    subject: string,
    published: number | undefined,
    simulated: number,
  ) => {
    const stated = published !== undefined && Number.isFinite(published) ? published : null;

    comparison.push({
      statistic,
      subject,
      published: stated,
      simulated: round(simulated, 3),
      difference: stated === null ? null : round(simulated - stated, 3),
    });
  };

  spec.constructs.forEach((construct, position) => {
    const own = compositeScores[position] as number[];

    compare('mean', construct.name, construct.mean, mean(own));
    compare('sd', construct.name, construct.sd, standardDeviation(own));

    if (construct.items > 1) {
      compare('alpha', construct.name, construct.alpha, alphaOf(itemBlocks[position] as number[][]));
    }
  });

  for (const entry of spec.correlations ?? []) {
    const a = names.indexOf(entry.a);
    const b = names.indexOf(entry.b);
    if (a < 0 || b < 0 || a === b) continue;

    compare(
      'correlation',
      `${entry.a} ~ ${entry.b}`,
      entry.r,
      pearson(compositeScores[a] as number[], compositeScores[b] as number[]),
    );
  }

  /* Standardised betas of each outcome on its published causes, from the scores. */
  const outcomes = [...new Set((spec.paths ?? []).map((path) => path.to))];

  for (const outcome of outcomes) {
    const causes = (spec.paths ?? []).filter((path) => path.to === outcome);
    const y = standardise(compositeScores[names.indexOf(outcome)] as number[]);
    const xs = causes.map((path) => standardise(compositeScores[names.indexOf(path.from)] as number[]));

    let betas: number[];

    try {
      betas = leastSquares(
        y.map((_, row) => xs.map((x) => x[row] as number)),
        y,
      );
    } catch {
      continue;
    }

    causes.forEach((path, position) => {
      compare('path', `${path.from} → ${path.to}`, path.beta, betas[position] ?? Number.NaN);
    });
  }

  for (const variable of demographics) {
    const spec_ = (spec.demographics ?? []).find((entry) => entry.name === variable.name);
    const total = spec_?.categories.reduce((sum, category) => sum + Math.max(0, category.share), 0) || 1;

    spec_?.categories.forEach((category, position) => {
      compare(
        'share',
        `${variable.name}: ${category.label}`,
        category.share / total,
        (variable.counts[position] as number) / spec.n,
      );
    });
  }

  return {
    dataset: { columns, rows, source, skippedRows: 0 },
    comparison,
    assumptions,
    seed: spec.seed,
  };
}

function standardise(values: number[]): number[] {
  const centre = mean(values);
  const spread = standardDeviation(values) || 1;
  return values.map((value) => (value - centre) / spread);
}

/* -------------------------------------------------------------------------- */
/*                              Recognising a file                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a table is a simulation, from the table itself.
 *
 * The stored flag is lost the moment a file is downloaded, and a simulated
 * file uploaded again would otherwise arrive as the researcher's own data. The
 * marker column and the file name both survive a round trip through Excel, so
 * either is enough.
 */
export function looksSimulated(filename: string, columns: string[]): boolean {
  if (filename.trim().toUpperCase().startsWith(SIMULATED_PREFIX)) return true;
  return columns.some((column) => isSimulationMarker(column));
}

/** Whether a column is the simulation marker, however a spreadsheet re-cased or padded it. */
export function isSimulationMarker(column: string): boolean {
  return column.trim().toLowerCase() === SIMULATED_COLUMN;
}
