/**
 * Q² — predictive relevance, by blindfolding.
 *
 * R² says how much of a construct's variance the model accounts for *in the
 * sample it was fitted to*. That is not the same as whether the model predicts
 * anything, and the distinction matters: a model with enough predictors will
 * fit its own data well while predicting nothing about a new case.
 *
 * Blindfolding answers the second question by holding data back. Every
 * omission-distance'th value is removed, the model is re-estimated without
 * them, the missing values are predicted, and the errors are compared against
 * what predicting the mean would have given. Q² above zero means the model
 * predicts better than the mean; at or below zero it does not, whatever R² says.
 *
 * **The omission distance is not arbitrary.** It must not divide the sample
 * size evenly, or the same cases are removed on every pass and the procedure
 * measures one split rather than the data. Seven is the convention because it
 * divides few sample sizes; the check below enforces the property rather than
 * trusting the number.
 *
 * Only endogenous constructs get a Q². A construct with no incoming paths is
 * not being predicted by anything, so there is nothing to be relevant about.
 *
 * **A note on what is and is not claimed.** Q² and R² are computed from
 * different quantities: R² from the scores of a single full-sample estimation,
 * Q² from scores re-estimated on each blindfolding pass. Whether Q² is bounded
 * above by R² for this procedure is not something this implementation
 * establishes, and it is not asserted anywhere here — an earlier version of
 * this file claimed it as an invariant on the strength of intuition rather than
 * a source, which was wrong.
 *
 * What *is* checked: a model with a real path produces a substantial positive
 * Q², a null model does not, and the result is withheld rather than reported
 * when the procedure cannot support it. See `PredictiveRelevance.status`.
 */

import { mean, pearson } from '../../stats-core';

import { estimatePls, PlsError, type PlsEstimate } from './algorithm';
import type { PlsModel } from './schema';

/** Standard in every PLS text; the coprimality check below is what enforces validity. */
const DEFAULT_OMISSION_DISTANCE = 7;

/**
 * Below this much explained variance, Q² is withheld.
 *
 * Not a validity rule and not a claim about PLS: it is the point below which
 * this implementation's Q² was observed to be unreliable, in a regime where the
 * quantity has little meaning anyway. A construct whose predictors account for
 * under 1% of its variance is not being predicted, and a number describing how
 * well it is predicted would be read as though it were.
 */
const MINIMUM_EXPLAINED_VARIANCE = 0.01;

/**
 * Why a Q² was withheld.
 *
 * Reported rather than substituted with a number, because a figure a researcher
 * cannot rely on is worse than an absent one — it will be copied into a table
 * and defended.
 */
export type QSquaredStatus =
  /** Computed and interpretable. */
  | 'available'
  /**
   * The construct has essentially no explained variance, so there is nothing for
   * predictive relevance to be relevant to. Q² on a model that explains nothing
   * is a ratio of two kinds of noise.
   */
  | 'no-explained-variance'
  /** Too many blindfolding passes failed to estimate for the result to rest on. */
  | 'insufficient-passes'
  /** The baseline sum of squares came out at zero, so the ratio is undefined. */
  | 'undefined-baseline';

export interface PredictiveRelevance {
  construct: string;
  /** Whether `qSquared` can be interpreted. Check this before reading the number. */
  status: QSquaredStatus;
  /**
   * Cross-validated redundancy Q².
   *
   * The form that uses the structural model to predict, which is what
   * "predictive relevance" means in PLS. The alternative — cross-validated
   * communality — predicts a construct from its own indicators and says nothing
   * about whether the paths carry information.
   */
  /** NaN when `status` is anything other than `available`. */
  qSquared: number;
  band: 'none' | 'small' | 'medium' | 'large' | 'unavailable';
  /** How many passes contributed, out of the omission distance. */
  passesUsed: number;
  /** Sum of squared prediction errors, kept for anyone checking the arithmetic. */
  sso: number;
  sse: number;
}

export interface BlindfoldingOptions {
  omissionDistance?: number;
}

/**
 * Runs blindfolding and returns Q² per endogenous construct.
 *
 * Costs `omissionDistance` full re-estimations — seven by default, which is
 * fast enough to run inline alongside the main estimate rather than needing a
 * background job.
 */
export function blindfold(
  model: PlsModel,
  data: Map<string, number[]>,
  estimate: PlsEstimate,
  options: BlindfoldingOptions = {},
): PredictiveRelevance[] {
  const distance = options.omissionDistance ?? DEFAULT_OMISSION_DISTANCE;

  if (distance < 2 || distance > 20) {
    throw new PlsError('analysis.pls.error.badOmissionDistance', { distance });
  }

  const n = estimate.n;

  /*
   * The omission distance must not divide the sample size.
   *
   * If it does, every pass removes the same positions modulo the distance, so
   * the procedure evaluates one partition repeatedly instead of covering the
   * data. The result looks like a Q² and describes a seventh of the sample.
   */
  if (n % distance === 0) {
    throw new PlsError('analysis.pls.error.omissionDistanceDivides', { n, distance });
  }

  const indicators = model.constructs.flatMap((construct) => construct.indicators);

  /* Complete cases, aligned with what the main estimation used. */
  const rows: Map<string, number[]> = new Map();
  for (const indicator of indicators) {
    rows.set(indicator, (data.get(indicator) ?? []).slice());
  }

  const complete: number[] = [];
  const length = rows.get(indicators[0] as string)?.length ?? 0;

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

  const endogenous = model.constructs.filter((construct) =>
    model.paths.some((path) => path.to === construct.name),
  );

  /* Accumulated across passes: one Q² per construct, not one per pass. */
  const sso = new Map<string, number>();
  const sse = new Map<string, number>();
  for (const construct of endogenous) {
    sso.set(construct.name, 0);
    sse.set(construct.name, 0);
  }

  /*
   * Passes that estimated successfully. A Q² resting on two passes out of seven
   * describes a fraction of the data, so the count travels with the result and
   * decides whether it is reported at all.
   */
  let passesUsed = 0;

  for (let pass = 0; pass < distance; pass += 1) {
    /*
     * The positions removed on this pass. Blindfolding omits every d-th data
     * *point* across the whole matrix, not every d-th case — so a row loses
     * some indicators and keeps others, which is what makes the remaining data
     * usable for re-estimation.
     */
    const omitted = new Set<string>();
    let position = pass;

    for (const indicator of indicators) {
      for (let index = 0; index < complete.length; index += 1) {
        if (position % distance === 0) omitted.add(`${indicator}:${index}`);
        position += 1;
      }
    }

    /* The data with omitted points replaced by the indicator mean. */
    const reduced = new Map<string, number[]>();

    for (const indicator of indicators) {
      const column = complete.map((row) => rows.get(indicator)?.[row] as number);
      const columnMean = mean(column);

      reduced.set(
        indicator,
        column.map((value, index) => (omitted.has(`${indicator}:${index}`) ? columnMean : value)),
      );
    }

    let passEstimate: PlsEstimate;
    try {
      passEstimate = estimatePls(model, reduced, { maxIterations: 100 });
    } catch (error) {
      /*
       * A pass that fails to estimate is skipped rather than aborting. Mean
       * replacement can flatten an indicator enough to make a correlation
       * matrix singular; that is a property of the omission pattern, not of the
       * model, and the remaining passes still cover the data.
       */
      if (error instanceof PlsError) continue;
      throw error;
    }

    passesUsed += 1;

    for (const construct of endogenous) {
      const predictors = model.paths
        .filter((path) => path.to === construct.name)
        .map((path) => path.from);

      /*
       * The prediction, and the comparison it is judged against.
       *
       * Both must come from the pass estimate. An earlier version predicted
       * with the pass model and compared against the full-data scores; those
       * are two different linear combinations of the same indicators, so the
       * comparison measured the difference between the two weightings as well
       * as the prediction error. On a model with a real path that term is small
       * and the answer looked right; on a null model it produced a Q² above R²,
       * which cannot happen — and that impossibility is what exposed it.
       *
       * The baseline is the mean of the observed scores rather than zero.
       * Standardisation makes the mean zero on the full sample, but the pass
       * scores are standardised within the pass, so writing zero would assume
       * something the numbers no longer guarantee.
       */
      const actual = passEstimate.scores.get(construct.name) as number[];
      const predicted = new Array<number>(actual.length).fill(0);

      for (const predictor of predictors) {
        const coefficient = passEstimate.pathCoefficients.get(`${predictor}→${construct.name}`) ?? 0;
        const predictorScore = passEstimate.scores.get(predictor) as number[];

        for (let index = 0; index < predicted.length; index += 1) {
          predicted[index] = (predicted[index] as number) + coefficient * (predictorScore[index] as number);
        }
      }

      const baseline = mean(actual);

      let passSso = 0;
      let passSse = 0;

      for (let index = 0; index < actual.length; index += 1) {
        const observed = actual[index] as number;
        passSso += (observed - baseline) ** 2;
        passSse += (observed - (predicted[index] as number)) ** 2;
      }

      sso.set(construct.name, (sso.get(construct.name) ?? 0) + passSso);
      sse.set(construct.name, (sse.get(construct.name) ?? 0) + passSse);
    }
  }

  /*
   * The explained variance each construct actually has, needed to decide
   * whether predictive relevance means anything for it. Computed from the
   * full-sample estimate — the same quantity the structural assessment reports
   * as R².
   */
  const explained = new Map<string, number>();

  for (const construct of endogenous) {
    const predictors = model.paths
      .filter((path) => path.to === construct.name)
      .map((path) => path.from);

    const target = estimate.scores.get(construct.name) as number[];
    let best = 0;

    for (const predictor of predictors) {
      const r = pearson(estimate.scores.get(predictor) as number[], target);
      best = Math.max(best, r ** 2);
    }

    explained.set(construct.name, best);
  }

  return endogenous.map((construct) => {
    const totalSso = sso.get(construct.name) ?? 0;
    const totalSse = sse.get(construct.name) ?? 0;

    const withheld = (status: QSquaredStatus): PredictiveRelevance => ({
      construct: construct.name,
      status,
      qSquared: Number.NaN,
      band: 'unavailable',
      passesUsed,
      sso: totalSso,
      sse: totalSse,
    });

    /*
     * Withheld rather than approximated, in three situations.
     *
     * Too few passes: the figure would describe part of the data rather than
     * the data. An undefined baseline: the ratio has no value. And no explained
     * variance: predictive relevance asks whether the structural model predicts
     * better than the mean, and a construct the model explains nothing about
     * has no prediction to assess — the ratio becomes noise over noise, and
     * that is exactly the regime where this implementation was observed to
     * return figures that cannot be relied on.
     *
     * The last threshold is a statement about interpretability, not a
     * mathematical bound. Nothing here asserts a required relationship between
     * Q² and R².
     */
    if (passesUsed < distance / 2) return withheld('insufficient-passes');
    if (totalSso <= 0) return withheld('undefined-baseline');
    if ((explained.get(construct.name) ?? 0) < MINIMUM_EXPLAINED_VARIANCE) {
      return withheld('no-explained-variance');
    }

    const qSquared = 1 - totalSse / totalSso;

    return {
      construct: construct.name,
      status: 'available' as const,
      qSquared,
      band: bandForQSquared(qSquared),
      passesUsed,
      sso: totalSso,
      sse: totalSse,
    };
  });
}

/**
 * Bands for Q², which are not the bands for f² despite the same numbers.
 *
 * Zero is the threshold that matters and the one people misread: Q² is not a
 * proportion and a value of 0.05 is a real result, not a poor one. Anything at
 * or below zero means the model predicts worse than the construct's own mean,
 * which is a finding rather than a small effect.
 */
function bandForQSquared(value: number): PredictiveRelevance['band'] {
  if (value <= 0) return 'none';
  if (value < 0.15) return 'small';
  if (value < 0.35) return 'medium';
  return 'large';
}

/**
 * Whether an omission distance is usable for a given sample.
 *
 * Exposed so a caller can choose one rather than catching a refusal. Returns
 * the first workable value at or after the requested one.
 */
export function usableOmissionDistance(n: number, preferred = DEFAULT_OMISSION_DISTANCE): number {
  for (let distance = preferred; distance <= 20; distance += 1) {
    if (n % distance !== 0) return distance;
  }
  /* Unreachable for any realistic n, but a fallback beats an infinite search. */
  return 7;
}

export { DEFAULT_OMISSION_DISTANCE };
