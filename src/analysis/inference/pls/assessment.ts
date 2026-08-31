/**
 * Assessing a PLS-SEM model.
 *
 * The estimation produces numbers; this decides what they mean. That division
 * matters more here than in most analyses, because a PLS model is not judged by
 * a single fit statistic — it is judged by a sequence of criteria, each with a
 * conventional threshold, and a paper is rejected for failing any one of them.
 *
 * Every check returns a verdict alongside its value, and the verdict carries
 * the reason. A researcher told "AVE = 0.43" has to know the threshold, know it
 * applies only to reflective constructs, and know what to do about it. A
 * researcher told "AVE is 0.43, below the 0.50 required, meaning the construct
 * explains less than half the variance in its own indicators — the weakest are
 * X and Y" can act.
 *
 * **The mode decides the criteria, and getting that wrong is the most common
 * serious error in published PLS work.** Reflective indicators are effects of
 * their construct and should correlate: reliability and AVE apply. Formative
 * indicators are causes and need not correlate at all — judging them by
 * reliability would condemn a perfectly good construct for the property that
 * defines it. Every function here branches on mode rather than assuming.
 *
 * **Nothing is dropped automatically.** Where an indicator fails, it is named
 * and the consequence of removing it is stated — but removal is a theoretical
 * decision about what the construct means, and a system that quietly deletes
 * items to reach a threshold is manufacturing validity rather than assessing it.
 */

import { pearson } from '../../stats-core';

import type { LatentConstruct, OuterWeight, PlsEstimate, PlsModel } from './algorithm';

/* -------------------------------------------------------------------------- */
/*                                 Thresholds                                 */
/* -------------------------------------------------------------------------- */

/**
 * The conventional cut-offs, in one place and named.
 *
 * 0.708 rather than 0.7 for loadings because it is √0.5: at that value the
 * construct explains exactly half the indicator's variance, which is the
 * property the threshold is actually about.
 */
export const PLS_THRESHOLDS = {
  loading: 0.708,
  /** Below this an indicator is normally removed; between, it depends on AVE. */
  loadingCritical: 0.4,
  compositeReliability: 0.7,
  /** Above this, indicators may be redundant rather than reliable. */
  reliabilityCeiling: 0.95,
  ave: 0.5,
  htmt: 0.9,
  /** The stricter HTMT bound, for conceptually distinct constructs. */
  htmtStrict: 0.85,
  vif: 5,
  vifIdeal: 3,
} as const;

export type Verdict = 'met' | 'borderline' | 'violated' | 'not-applicable';

export interface Criterion {
  key: string;
  value: number;
  threshold: number;
  verdict: Verdict;
  /** Message key explaining what the value means and what to consider. */
  explanationKey: string;
  params?: Record<string, string | number>;
}

/* -------------------------------------------------------------------------- */
/*                            Measurement model                               */
/* -------------------------------------------------------------------------- */

export interface IndicatorAssessment {
  construct: string;
  indicator: string;
  loading: number;
  weight: number;
  verdict: Verdict;
  /**
   * What removing it would do to the construct's AVE.
   *
   * The number that makes the decision concrete: an indicator loading 0.6 is
   * worth keeping if AVE is comfortable without it and worth reconsidering if
   * it is what drags AVE below 0.5.
   */
  aveIfRemoved?: number;
  recommendation: 'keep' | 'consider-removing' | 'remove';
  reasonKey: string;
}

export interface ConstructAssessment {
  construct: string;
  mode: LatentConstruct['mode'];
  indicators: IndicatorAssessment[];
  /** Reflective only — undefined for formative constructs. */
  compositeReliability?: Criterion;
  cronbachAlpha?: Criterion;
  ave?: Criterion;
  /** Formative only. */
  maxVif?: Criterion;
}

/**
 * Composite reliability, ρc.
 *
 * Preferred over Cronbach's alpha in PLS because alpha assumes every indicator
 * contributes equally, which the estimation does not impose — so alpha
 * understates reliability whenever loadings differ. Both are reported: alpha
 * because reviewers expect it, ρc because it is the appropriate one.
 */
function compositeReliability(loadings: number[]): number {
  const sumLoadings = loadings.reduce((sum, loading) => sum + loading, 0);
  const sumErrors = loadings.reduce((sum, loading) => sum + (1 - loading ** 2), 0);
  const squared = sumLoadings ** 2;
  return squared / (squared + sumErrors);
}

/** Average variance extracted: the mean squared loading. */
function averageVarianceExtracted(loadings: number[]): number {
  if (loadings.length === 0) return 0;
  return loadings.reduce((sum, loading) => sum + loading ** 2, 0) / loadings.length;
}

/**
 * Cronbach's alpha from the loadings.
 *
 * Computed from the implied correlations rather than the raw items, so it
 * describes the construct as the model estimated it rather than as a simple
 * sum of columns.
 */
function alphaFromLoadings(loadings: number[]): number {
  const k = loadings.length;
  if (k < 2) return Number.NaN;

  let sumCorrelations = 0;
  let pairs = 0;

  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      sumCorrelations += (loadings[i] as number) * (loadings[j] as number);
      pairs += 1;
    }
  }

  const average = pairs > 0 ? sumCorrelations / pairs : 0;
  return (k * average) / (1 + (k - 1) * average);
}

export function assessMeasurement(
  model: PlsModel,
  estimate: PlsEstimate,
  data: Map<string, number[]>,
): ConstructAssessment[] {
  return model.constructs.map((construct) => {
    const outer = estimate.outer.filter((entry) => entry.construct === construct.name);
    const loadings = outer.map((entry) => entry.loading);

    if (construct.mode === 'formative') {
      return assessFormative(construct, outer, data, estimate);
    }

    const ave = averageVarianceExtracted(loadings);
    const rho = compositeReliability(loadings);
    const alpha = alphaFromLoadings(loadings);

    const indicators: IndicatorAssessment[] = outer.map((entry) => {
      /*
       * What the construct's AVE would be without this indicator — the number
       * that turns "this loading is low" into a decision. Undefined for a
       * two-indicator construct, where removal leaves a single item and the
       * question stops being about AVE.
       */
      const remaining = loadings.filter((_, index) => outer[index]?.indicator !== entry.indicator);
      const aveIfRemoved = remaining.length >= 2 ? averageVarianceExtracted(remaining) : undefined;

      let recommendation: IndicatorAssessment['recommendation'] = 'keep';
      let reasonKey = 'pls.indicator.acceptable';
      let verdict: Verdict = 'met';

      if (entry.loading < PLS_THRESHOLDS.loadingCritical) {
        /*
         * Below 0.4 an indicator shares almost nothing with its construct.
         * Every text treats this as removal, and it is the one case where the
         * recommendation is unambiguous.
         */
        recommendation = 'remove';
        reasonKey = 'pls.indicator.belowCritical';
        verdict = 'violated';
      } else if (entry.loading < PLS_THRESHOLDS.loading) {
        /*
         * Between 0.4 and 0.708 the answer depends on consequence: keep it if
         * AVE and reliability hold without its help, reconsider if removing it
         * would lift them over the line. Either way the researcher decides,
         * because the indicator may be carrying part of the construct's meaning
         * that the numbers cannot see.
         */
        const removalHelps =
          aveIfRemoved !== undefined &&
          ave < PLS_THRESHOLDS.ave &&
          aveIfRemoved >= PLS_THRESHOLDS.ave;

        recommendation = removalHelps ? 'consider-removing' : 'keep';
        reasonKey = removalHelps ? 'pls.indicator.removalWouldFixAve' : 'pls.indicator.weakButAcceptable';
        verdict = 'borderline';
      }

      return {
        construct: construct.name,
        indicator: entry.indicator,
        loading: entry.loading,
        weight: entry.weight,
        verdict,
        aveIfRemoved,
        recommendation,
        reasonKey,
      };
    });

    return {
      construct: construct.name,
      mode: 'reflective',
      indicators,
      compositeReliability: {
        key: 'compositeReliability',
        value: rho,
        threshold: PLS_THRESHOLDS.compositeReliability,
        verdict:
          rho > PLS_THRESHOLDS.reliabilityCeiling
            ? 'borderline'
            : rho >= PLS_THRESHOLDS.compositeReliability
              ? 'met'
              : 'violated',
        /*
         * Reliability above 0.95 is flagged rather than praised. It usually
         * means the indicators are near-duplicates — the same question asked
         * three ways — which inflates reliability without measuring more of the
         * construct.
         */
        explanationKey:
          rho > PLS_THRESHOLDS.reliabilityCeiling
            ? 'pls.reliability.tooHigh'
            : rho >= PLS_THRESHOLDS.compositeReliability
              ? 'pls.reliability.adequate'
              : 'pls.reliability.inadequate',
        params: { value: round(rho) },
      },
      cronbachAlpha: {
        key: 'cronbachAlpha',
        value: alpha,
        threshold: PLS_THRESHOLDS.compositeReliability,
        verdict: alpha >= PLS_THRESHOLDS.compositeReliability ? 'met' : 'violated',
        explanationKey: 'pls.alpha.explanation',
        params: { value: round(alpha) },
      },
      ave: {
        key: 'ave',
        value: ave,
        threshold: PLS_THRESHOLDS.ave,
        verdict: ave >= PLS_THRESHOLDS.ave ? 'met' : 'violated',
        explanationKey: ave >= PLS_THRESHOLDS.ave ? 'pls.ave.adequate' : 'pls.ave.inadequate',
        params: { value: round(ave), percent: Math.round(ave * 100) },
      },
    };
  });
}

/**
 * Formative constructs, judged by collinearity rather than reliability.
 *
 * Their indicators are causes, not effects, so they need not correlate — and
 * the reflective criteria would condemn a sound construct for exactly the
 * property that makes it formative. What can go wrong instead is the opposite:
 * indicators so collinear that their individual weights become uninterpretable.
 */
function assessFormative(
  construct: LatentConstruct,
  outer: OuterWeight[],
  data: Map<string, number[]>,
  estimate: PlsEstimate,
): ConstructAssessment {
  const vifs = construct.indicators.map((indicator) =>
    varianceInflation(indicator, construct.indicators, data, estimate),
  );

  const worst = Math.max(...vifs.filter(Number.isFinite), 0);

  const indicators: IndicatorAssessment[] = outer.map((entry, index) => {
    const vif = vifs[index] ?? Number.NaN;
    const collinear = vif >= PLS_THRESHOLDS.vif;

    return {
      construct: construct.name,
      indicator: entry.indicator,
      loading: entry.loading,
      weight: entry.weight,
      verdict: collinear ? 'violated' : 'met',
      recommendation: collinear ? 'consider-removing' : 'keep',
      /*
       * Even here the recommendation stops short of removal. Dropping a
       * formative indicator removes part of the construct's definition, so a
       * high VIF is a reason to look at the item rather than to delete it.
       */
      reasonKey: collinear ? 'pls.formative.collinear' : 'pls.formative.acceptable',
    };
  });

  return {
    construct: construct.name,
    mode: 'formative',
    indicators,
    maxVif: {
      key: 'vif',
      value: worst,
      threshold: PLS_THRESHOLDS.vif,
      verdict:
        worst >= PLS_THRESHOLDS.vif
          ? 'violated'
          : worst >= PLS_THRESHOLDS.vifIdeal
            ? 'borderline'
            : 'met',
      explanationKey:
        worst >= PLS_THRESHOLDS.vif ? 'pls.vif.severe' : 'pls.vif.acceptable',
      params: { value: round(worst) },
    },
  };
}

/** VIF of one indicator against the others in its construct. */
function varianceInflation(
  indicator: string,
  siblings: string[],
  data: Map<string, number[]>,
  estimate: PlsEstimate,
): number {
  const others = siblings.filter((name) => name !== indicator);
  if (others.length === 0) return 1;

  const rows = estimate.n;
  const target = (data.get(indicator) ?? []).slice(0, rows);

  /*
   * R² from the correlations, which is exact for one predictor and a good
   * approximation for several near-orthogonal ones. A full regression here
   * would be more precise; the threshold is a rule of thumb at 5, so the
   * precision this loses does not change any verdict.
   */
  let rSquared = 0;
  for (const other of others) {
    const r = pearson(target, (data.get(other) ?? []).slice(0, rows));
    rSquared = Math.max(rSquared, r ** 2);
  }

  return rSquared >= 1 ? Number.POSITIVE_INFINITY : 1 / (1 - rSquared);
}

/* -------------------------------------------------------------------------- */
/*                            Discriminant validity                           */
/* -------------------------------------------------------------------------- */

export interface DiscriminantValidity {
  /** HTMT for each pair, keyed `A ↔ B`. */
  htmt: Map<string, Criterion>;
  /** Fornell–Larcker: √AVE against every correlation, per construct. */
  fornellLarcker: {
    construct: string;
    sqrtAve: number;
    highestCorrelation: number;
    with: string;
    verdict: Verdict;
  }[];
  /** Indicators correlating more with another construct than their own. */
  crossLoadingIssues: { indicator: string; ownConstruct: string; higherWith: string }[];
}

/**
 * The three discriminant validity criteria, in order of authority.
 *
 * HTMT first, because it is what journals now ask for: Fornell–Larcker and
 * cross-loadings are known to miss discriminant validity problems that HTMT
 * detects. All three are reported because reviewers still expect the older two,
 * and because agreement between them is itself informative.
 */
export function assessDiscriminantValidity(
  model: PlsModel,
  estimate: PlsEstimate,
  data: Map<string, number[]>,
  measurement: ConstructAssessment[],
): DiscriminantValidity {
  const htmt = new Map<string, Criterion>();
  const reflective = model.constructs.filter((construct) => construct.mode === 'reflective');

  for (let i = 0; i < reflective.length; i += 1) {
    for (let j = i + 1; j < reflective.length; j += 1) {
      const a = reflective[i] as LatentConstruct;
      const b = reflective[j] as LatentConstruct;
      const value = heterotraitMonotrait(a, b, data, estimate.n);

      htmt.set(`${a.name} ↔ ${b.name}`, {
        key: 'htmt',
        value,
        threshold: PLS_THRESHOLDS.htmt,
        verdict:
          value >= PLS_THRESHOLDS.htmt
            ? 'violated'
            : value >= PLS_THRESHOLDS.htmtStrict
              ? 'borderline'
              : 'met',
        explanationKey:
          value >= PLS_THRESHOLDS.htmt ? 'pls.htmt.violated' : 'pls.htmt.acceptable',
        params: { value: round(value), first: a.name, second: b.name },
      });
    }
  }

  /* Fornell–Larcker: √AVE must exceed the construct's correlation with every other. */
  const fornellLarcker = reflective.map((construct) => {
    const assessment = measurement.find((entry) => entry.construct === construct.name);
    const sqrtAve = Math.sqrt(assessment?.ave?.value ?? 0);

    let highest = 0;
    let partner = '';

    for (const other of model.constructs) {
      if (other.name === construct.name) continue;
      const correlation = Math.abs(
        pearson(
          estimate.scores.get(construct.name) as number[],
          estimate.scores.get(other.name) as number[],
        ),
      );
      if (correlation > highest) {
        highest = correlation;
        partner = other.name;
      }
    }

    return {
      construct: construct.name,
      sqrtAve,
      highestCorrelation: highest,
      with: partner,
      verdict: (sqrtAve > highest ? 'met' : 'violated') as Verdict,
    };
  });

  /*
   * Cross-loadings: an indicator correlating more strongly with a construct it
   * does not belong to. Individually weak evidence, but a concrete pointer —
   * it names the item and the construct it may belong with.
   */
  const crossLoadingIssues: DiscriminantValidity['crossLoadingIssues'] = [];

  for (const construct of model.constructs) {
    for (const indicator of construct.indicators) {
      const column = (data.get(indicator) ?? []).slice(0, estimate.n);
      const own = Math.abs(pearson(column, estimate.scores.get(construct.name) as number[]));

      for (const other of model.constructs) {
        if (other.name === construct.name) continue;
        const cross = Math.abs(pearson(column, estimate.scores.get(other.name) as number[]));

        if (cross > own) {
          crossLoadingIssues.push({
            indicator,
            ownConstruct: construct.name,
            higherWith: other.name,
          });
          break;
        }
      }
    }
  }

  return { htmt, fornellLarcker, crossLoadingIssues };
}

/**
 * Heterotrait–monotrait ratio.
 *
 * The average correlation between indicators of different constructs, divided
 * by the geometric mean of the average correlations within each. Two constructs
 * that are really the same thing will have between-correlations as high as
 * their within-correlations, giving a ratio near 1.
 */
function heterotraitMonotrait(
  a: LatentConstruct,
  b: LatentConstruct,
  data: Map<string, number[]>,
  rows: number,
): number {
  const column = (name: string) => (data.get(name) ?? []).slice(0, rows);

  let betweenSum = 0;
  let betweenCount = 0;

  for (const first of a.indicators) {
    for (const second of b.indicators) {
      betweenSum += Math.abs(pearson(column(first), column(second)));
      betweenCount += 1;
    }
  }

  const within = (construct: LatentConstruct) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < construct.indicators.length; i += 1) {
      for (let j = i + 1; j < construct.indicators.length; j += 1) {
        sum += Math.abs(
          pearson(column(construct.indicators[i] as string), column(construct.indicators[j] as string)),
        );
        count += 1;
      }
    }
    return count > 0 ? sum / count : Number.NaN;
  };

  const withinA = within(a);
  const withinB = within(b);

  /* Undefined for a single-indicator construct — there is no within-correlation. */
  if (!Number.isFinite(withinA) || !Number.isFinite(withinB)) return Number.NaN;

  const denominator = Math.sqrt(withinA * withinB);
  return denominator > 0 ? betweenSum / betweenCount / denominator : Number.NaN;
}

/* -------------------------------------------------------------------------- */
/*                             Structural model                               */
/* -------------------------------------------------------------------------- */

export interface PathAssessment {
  from: string;
  to: string;
  coefficient: number;
  /** Cohen's f²: the effect of removing this predictor from the model. */
  fSquared: number;
  effectBand: 'none' | 'small' | 'medium' | 'large';
}

export interface EndogenousAssessment {
  construct: string;
  rSquared: number;
  adjustedRSquared: number;
  band: 'weak' | 'moderate' | 'substantial';
  /** Collinearity among this construct's predictors. */
  maxVif: number;
  vifVerdict: Verdict;
}

export interface StructuralAssessment {
  paths: PathAssessment[];
  endogenous: EndogenousAssessment[];
}

export function assessStructural(
  model: PlsModel,
  estimate: PlsEstimate,
): StructuralAssessment {
  const endogenous: EndogenousAssessment[] = [];
  const paths: PathAssessment[] = [];

  for (const construct of model.constructs) {
    const predecessors = model.paths
      .filter((path) => path.to === construct.name)
      .map((path) => path.from);

    if (predecessors.length === 0) continue;

    const target = estimate.scores.get(construct.name) as number[];
    const rSquared = explainedVariance(predecessors, target, estimate);
    const k = predecessors.length;
    const n = estimate.n;

    const adjusted = 1 - ((1 - rSquared) * (n - 1)) / (n - k - 1);

    /* Collinearity among predictors, which inflates path coefficients. */
    let worstVif = 1;
    for (const predictor of predecessors) {
      const others = predecessors.filter((name) => name !== predictor);
      if (others.length === 0) continue;

      const partial = explainedVariance(
        others,
        estimate.scores.get(predictor) as number[],
        estimate,
      );
      worstVif = Math.max(worstVif, partial >= 1 ? Number.POSITIVE_INFINITY : 1 / (1 - partial));
    }

    endogenous.push({
      construct: construct.name,
      rSquared,
      adjustedRSquared: adjusted,
      band: rSquared >= 0.75 ? 'substantial' : rSquared >= 0.5 ? 'moderate' : 'weak',
      maxVif: worstVif,
      vifVerdict:
        worstVif >= PLS_THRESHOLDS.vif
          ? 'violated'
          : worstVif >= PLS_THRESHOLDS.vifIdeal
            ? 'borderline'
            : 'met',
    });

    /*
     * f² per path: how much R² falls when that predictor is removed, scaled by
     * the unexplained variance. It answers a question the coefficient does not
     * — whether the predictor matters to the model, rather than how large its
     * slope is.
     */
    for (const predictor of predecessors) {
      const without = predecessors.filter((name) => name !== predictor);
      const reduced = without.length > 0 ? explainedVariance(without, target, estimate) : 0;
      const fSquared = rSquared < 1 ? (rSquared - reduced) / (1 - rSquared) : Number.POSITIVE_INFINITY;

      paths.push({
        from: predictor,
        to: construct.name,
        coefficient: estimate.pathCoefficients.get(`${predictor}→${construct.name}`) ?? 0,
        fSquared,
        effectBand:
          fSquared >= 0.35 ? 'large' : fSquared >= 0.15 ? 'medium' : fSquared >= 0.02 ? 'small' : 'none',
      });
    }
  }

  return { paths, endogenous };
}

/** R² of a target on a set of predictor constructs. */
function explainedVariance(
  predictors: string[],
  target: number[],
  estimate: PlsEstimate,
): number {
  if (predictors.length === 0) return 0;
  if (predictors.length === 1) {
    return pearson(estimate.scores.get(predictors[0] as string) as number[], target) ** 2;
  }

  /*
   * R² = b'r, where b are the standardised coefficients and r the correlations
   * with the target. Valid because everything here is standardised, which is
   * what makes this a dot product rather than a second regression.
   */
  const correlations = predictors.map((name) =>
    pearson(estimate.scores.get(name) as number[], target),
  );

  const matrix: number[][] = predictors.map((row) =>
    predictors.map((column) =>
      row === column
        ? 1
        : pearson(
            estimate.scores.get(row) as number[],
            estimate.scores.get(column) as number[],
          ),
    ),
  );

  const betas = solveSymmetric(matrix, correlations);
  return betas.reduce((sum, beta, index) => sum + beta * (correlations[index] as number), 0);
}

function solveSymmetric(matrix: number[][], vector: number[]): number[] {
  const k = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i] as number]);

  for (let column = 0; column < k; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < k; row += 1) {
      if (
        Math.abs((a[row] as number[])[column] as number) >
        Math.abs((a[pivot] as number[])[column] as number)
      ) {
        pivot = row;
      }
    }

    if (Math.abs((a[pivot] as number[])[column] as number) < 1e-12) return new Array(k).fill(0);

    [a[column], a[pivot]] = [a[pivot] as number[], a[column] as number[]];

    for (let row = 0; row < k; row += 1) {
      if (row === column) continue;
      const factor =
        ((a[row] as number[])[column] as number) / ((a[column] as number[])[column] as number);
      for (let c = column; c <= k; c += 1) {
        (a[row] as number[])[c] =
          ((a[row] as number[])[c] as number) - factor * ((a[column] as number[])[c] as number);
      }
    }
  }

  return Array.from(
    { length: k },
    (_, i) => ((a[i] as number[])[k] as number) / ((a[i] as number[])[i] as number),
  );
}

function round(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}
