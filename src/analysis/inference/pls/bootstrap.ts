/**
 * Bootstrapping a PLS model.
 *
 * PLS has no closed form for the standard error of a path coefficient. There is
 * no formula to evaluate — the sampling distribution is obtained by resampling
 * the data with replacement, refitting the whole model each time, and looking at
 * how much the estimates move. Five thousand times, by convention, because
 * anything less leaves the percentile intervals visibly unstable between runs.
 *
 * That is the entire reason this cannot happen inside a web request: five
 * thousand full estimations take a minute or more, and the request will be gone
 * long before.
 *
 * **Sign indeterminacy is the subtlety that makes a naive implementation
 * wrong.** A latent variable's direction is arbitrary — multiply every weight
 * by −1 and the model fits identically, with every path coefficient flipped.
 * Across five thousand resamples some fraction will come back mirrored, and
 * averaging them unaltered drags coefficients toward zero and inflates every
 * standard error. Each resample is therefore compared against the original and
 * flipped back where it disagrees, which is what SmartPLS calls individual sign
 * change correction.
 *
 * Validated against mathematical properties — bootstrap means should sit near
 * the original estimates, intervals should contain them, and a coefficient
 * built to be zero should have an interval spanning zero.
 */

import { estimatePls, type PlsEstimate, type PlsModel, PlsError } from './algorithm';

export interface BootstrapOptions {
  /**
   * Resamples. Five thousand is the reporting standard; a thousand is enough
   * for a quick look and visibly noisier at the third decimal.
   */
  resamples?: number;
  confidenceLevel?: number;
  /** Called with 0–100 so a caller can persist progress. */
  onProgress?: (percent: number) => void;
  /** Checked between resamples so a cancelled job stops promptly. */
  shouldStop?: () => boolean;
  /** Fixed seed makes a run reproducible, which matters for a thesis. */
  seed?: number;
}

export interface BootstrapInterval {
  /** `Satisfaction→Loyalty` for a path, or `Trust:trust1` for a loading. */
  key: string;
  /** The estimate from the original sample — what is reported. */
  original: number;
  /** The mean across resamples; a large gap from `original` signals instability. */
  bootstrapMean: number;
  standardError: number;
  /**
   * The t-statistic PLS reports: original / standard error.
   *
   * Judged against 1.96 for two-tailed significance at 5%, which is what every
   * PLS paper cites — the distribution is not exactly normal, but the
   * convention is universal and the percentile interval is reported alongside
   * for anyone who prefers it.
   */
  tStatistic: number;
  pValue: number;
  lower: number;
  upper: number;
  significant: boolean;
}

export interface BootstrapResult {
  paths: BootstrapInterval[];
  loadings: BootstrapInterval[];
  weights: BootstrapInterval[];
  resamples: number;
  /** Resamples that failed to converge and were discarded. */
  failed: number;
  confidenceLevel: number;
  durationMs: number;
  seed: number;
}

/**
 * Runs the bootstrap.
 *
 * Deliberately synchronous and single-threaded: it is CPU-bound arithmetic, and
 * the caller is a background job that owns the process for the duration. The
 * `onProgress` callback is what makes it observable, and `shouldStop` is what
 * makes it interruptible — without those, a minute of silence is
 * indistinguishable from a hang.
 */
export function bootstrapPls(
  model: PlsModel,
  data: Map<string, number[]>,
  original: PlsEstimate,
  options: BootstrapOptions = {},
): BootstrapResult {
  const resamples = options.resamples ?? 5000;
  const level = options.confidenceLevel ?? 0.95;
  const seed = options.seed ?? 20260101;
  const startedAt = Date.now();

  const random = seededRandom(seed);
  const n = original.n;

  const indicators = model.constructs.flatMap((construct) => construct.indicators);

  /*
   * The complete cases, extracted once. Resampling draws row indices from this
   * set rather than re-filtering each time — the filtering is the same work
   * repeated five thousand times otherwise.
   */
  const rows: Map<string, number[]> = new Map();
  for (const indicator of indicators) {
    const column = data.get(indicator) ?? [];
    rows.set(indicator, column.slice(0, column.length));
  }

  const completeRows = completeCaseIndices(indicators, rows);

  const pathSamples = new Map<string, number[]>();
  const loadingSamples = new Map<string, number[]>();
  const weightSamples = new Map<string, number[]>();

  let failed = 0;
  let lastReported = 0;

  for (let iteration = 0; iteration < resamples; iteration += 1) {
    if (options.shouldStop?.()) break;

    /* Draw n cases with replacement — the bootstrap sample. */
    const draw: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      draw[i] = completeRows[Math.floor(random() * completeRows.length)] as number;
    }

    const resampled = new Map<string, number[]>();
    for (const indicator of indicators) {
      const column = rows.get(indicator) as number[];
      resampled.set(
        indicator,
        draw.map((index) => column[index] as number),
      );
    }

    let estimate: PlsEstimate;
    try {
      estimate = estimatePls(model, resampled, { maxIterations: 100 });
    } catch (error) {
      /*
       * A resample that fails is discarded rather than aborting the run. With
       * replacement, an unlucky draw can produce a constant indicator or a
       * singular correlation matrix; that is a property of the draw, not of the
       * model. The count is reported — a high failure rate is itself a finding
       * about how fragile the model is.
       */
      if (error instanceof PlsError) {
        failed += 1;
        continue;
      }
      throw error;
    }

    if (!estimate.converged) {
      failed += 1;
      continue;
    }

    /* Sign correction, before anything is recorded. */
    const flips = signFlips(model, original, estimate);

    for (const [key, value] of estimate.pathCoefficients) {
      const [from, to] = key.split('→') as [string, string];
      /*
       * A path flips if exactly one of its endpoints did. If both flipped the
       * coefficient is unchanged, which is why this is an exclusive-or rather
       * than a check on either construct.
       */
      const flip = (flips.get(from) ?? 1) * (flips.get(to) ?? 1);
      push(pathSamples, key, value * flip);
    }

    for (const entry of estimate.outer) {
      const flip = flips.get(entry.construct) ?? 1;
      push(loadingSamples, `${entry.construct}:${entry.indicator}`, entry.loading * flip);
      push(weightSamples, `${entry.construct}:${entry.indicator}`, entry.weight * flip);
    }

    /*
     * Progress reported at whole percentages rather than per iteration: the
     * caller writes it to the database, and five thousand writes would cost
     * more than the arithmetic they describe.
     */
    const percent = Math.floor(((iteration + 1) / resamples) * 100);
    if (percent > lastReported) {
      lastReported = percent;
      options.onProgress?.(percent);
    }
  }

  const completed = resamples - failed;

  if (completed < resamples * 0.5) {
    throw new PlsError('analysis.pls.error.bootstrapUnstable', {
      failed,
      resamples,
    });
  }

  const originalPaths = new Map(original.pathCoefficients);
  const originalLoadings = new Map(
    original.outer.map((entry) => [`${entry.construct}:${entry.indicator}`, entry.loading]),
  );
  const originalWeights = new Map(
    original.outer.map((entry) => [`${entry.construct}:${entry.indicator}`, entry.weight]),
  );

  return {
    paths: summarise(pathSamples, originalPaths, level),
    loadings: summarise(loadingSamples, originalLoadings, level),
    weights: summarise(weightSamples, originalWeights, level),
    resamples: completed,
    failed,
    confidenceLevel: level,
    durationMs: Date.now() - startedAt,
    seed,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Sign correction                               */
/* -------------------------------------------------------------------------- */

/**
 * Which constructs came back mirrored, and need flipping.
 *
 * A latent variable's sign is arbitrary: negate its weights and the model fits
 * exactly as well with every relationship reversed. Comparing each resample's
 * loadings against the original tells us which constructs landed the other way
 * round.
 *
 * Decided by the sum of loading agreements rather than by a single indicator,
 * because one weak indicator can disagree by chance while the construct as a
 * whole did not flip.
 */
function signFlips(
  model: PlsModel,
  original: PlsEstimate,
  resample: PlsEstimate,
): Map<string, number> {
  const flips = new Map<string, number>();

  const originalLoadings = new Map(
    original.outer.map((entry) => [`${entry.construct}:${entry.indicator}`, entry.loading]),
  );

  for (const construct of model.constructs) {
    let agreement = 0;

    for (const entry of resample.outer) {
      if (entry.construct !== construct.name) continue;
      const before = originalLoadings.get(`${entry.construct}:${entry.indicator}`) ?? 0;
      agreement += before * entry.loading;
    }

    flips.set(construct.name, agreement < 0 ? -1 : 1);
  }

  return flips;
}

/* -------------------------------------------------------------------------- */
/*                                 Summarising                                */
/* -------------------------------------------------------------------------- */

function summarise(
  samples: Map<string, number[]>,
  originals: Map<string, number>,
  level: number,
): BootstrapInterval[] {
  const alpha = 1 - level;
  const results: BootstrapInterval[] = [];

  for (const [key, values] of samples) {
    if (values.length === 0) continue;

    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    const standardError = Math.sqrt(variance);

    const originalValue = originals.get(key) ?? mean;
    const tStatistic = standardError > 0 ? Math.abs(originalValue) / standardError : 0;

    /*
     * Percentile interval: the empirical quantiles of the resampled estimates.
     * Bias-corrected intervals are more accurate in principle and require
     * assumptions this makes no claim to satisfy; the percentile method is what
     * PLS software reports and what reviewers expect to see.
     */
    const lower = quantile(sorted, alpha / 2);
    const upper = quantile(sorted, 1 - alpha / 2);

    results.push({
      key,
      original: originalValue,
      bootstrapMean: mean,
      standardError,
      tStatistic,
      /* Two-tailed, from the normal approximation the t-statistic implies. */
      pValue: 2 * (1 - normalCdfApprox(tStatistic)),
      lower,
      upper,
      /*
       * Significance judged by the interval rather than by the t-statistic.
       * They usually agree; where they do not, the interval is the one that
       * came from the resampling rather than from an assumed distribution.
       */
      significant: !(lower <= 0 && upper >= 0),
    });
  }

  return results.sort((a, b) => a.key.localeCompare(b.key));
}

/** Linear interpolation between order statistics. */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;

  const position = p * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) return sorted[lower] as number;

  const weight = position - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/**
 * The normal CDF, to the accuracy a p-value needs.
 *
 * Abramowitz and Stegun 26.2.17, accurate to about 7.5e-8 — far beyond what
 * three reported decimals require. The full implementation in `distributions`
 * is not imported because this module is run five thousand times in a loop and
 * keeping its dependencies minimal keeps it predictable.
 */
function normalCdfApprox(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const probability =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));

  return z > 0 ? 1 - probability : probability;
}

/* -------------------------------------------------------------------------- */
/*                                  Support                                   */
/* -------------------------------------------------------------------------- */

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function completeCaseIndices(indicators: string[], rows: Map<string, number[]>): number[] {
  const length = rows.get(indicators[0] as string)?.length ?? 0;
  const complete: number[] = [];

  for (let row = 0; row < length; row += 1) {
    let usable = true;
    for (const indicator of indicators) {
      const value = rows.get(indicator)?.[row];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        usable = false;
        break;
      }
    }
    if (usable) complete.push(row);
  }

  return complete;
}

/**
 * A seeded generator, so a run can be reproduced.
 *
 * `Math.random` cannot be seeded, and a thesis that reports bootstrap results
 * should be able to produce the same numbers twice. Mulberry32: small, fast,
 * and with a period far beyond anything this needs.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
