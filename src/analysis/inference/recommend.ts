/**
 * Choosing the test.
 *
 * This is the module the whole first phase was built toward. Everything before
 * it computes a statistic once someone has decided which statistic to compute;
 * this decides, and explains the decision.
 *
 * **Why it is a function and not a prompt.** "Pick the right analysis" is the
 * request users will actually type, and it is tempting to hand it to a language
 * model. It must not be. The choice between a t-test and Mann–Whitney, or
 * between Pearson and Spearman, is fully determined by things already known
 * with certainty — how many groups there are, what measurement scale each
 * column is on, whether the residuals are plausibly normal. A model asked the
 * same question twice can answer differently, and a wrong answer here does not
 * produce a slightly-off number, it produces a p-value that does not mean what
 * the thesis says it means. So the rules are code, deterministic and testable,
 * and the model's job is only to explain in prose what this function decided.
 *
 * **Every recommendation carries its reasoning.** A bare "use ANOVA" teaches
 * nothing and cannot be checked. Each candidate here comes with the facts that
 * qualified it, the facts that would disqualify it, and — when it was not the
 * first choice — why something else won. A researcher who disagrees can see
 * exactly which premise to argue with.
 *
 * **Ordinal data is the case this exists to get right.** Likert responses are
 * stored as integers, and every piece of software will happily compute their
 * mean. The profiler already distinguishes an ordinal scale from an interval
 * one; this module is where that distinction finally does some work, by
 * declining to treat a five-point rating as a quantity when the sample is small
 * enough for it to matter.
 */

import type { ColumnProfile, DatasetProfile, MeasurementScale } from '../types';
import type { TestKey, VariableRole } from './types';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** The researcher's declaration of what each column is doing. Never inferred. */
export interface RoleAssignment {
  column: string;
  role: VariableRole;
}

export type RecommendationConfidence = 'recommended' | 'possible' | 'not-applicable';

export interface TestCandidate {
  test: TestKey;
  confidence: RecommendationConfidence;
  /**
   * Why this test fits, or does not. Message keys with parameters rather than
   * sentences, so the interface can say them in Arabic or English.
   */
  reasons: { code: string; params?: Record<string, string | number> }[];
  /** Conditions that would rule this test out if they turn out to hold. */
  caveats: { code: string; params?: Record<string, string | number> }[];
  /** True when the test is implemented and can actually be run today. */
  available: boolean;
}

export interface Recommendation {
  candidates: TestCandidate[];
  /** The first available `recommended` candidate, or null when nothing fits. */
  best: TestCandidate | null;
  /** Facts the recommendation was derived from, for the interface to show. */
  basis: {
    dependent: { column: string; scale: MeasurementScale; type: string } | null;
    grouping: { column: string; levels: number } | null;
    independents: { column: string; scale: MeasurementScale; type: string }[];
    n: number;
  };
  /** Why no test could be recommended, when none could. */
  blockers: { code: string; params?: Record<string, string | number> }[];
}

/**
 * Tests implemented and callable today.
 *
 * The point of this set is honesty. The recommender knows about non-parametric
 * alternatives because a violated assumption has to be able to name its
 * replacement — but naming one is not the same as offering it. A candidate
 * outside this set is returned with `available: false`, so the interface can
 * say "the appropriate test here is Mann–Whitney, which is not built yet"
 * rather than either silently substituting a test that is wrong for the data or
 * pretending the recommendation does not exist.
 */
const IMPLEMENTED: ReadonlySet<TestKey> = new Set<TestKey>([
  't.oneSample',
  't.independent',
  't.paired',
  'anova.oneWay',
  'correlation.pearson',
  'correlation.spearman',
  'chiSquare.independence',
  'chiSquare.goodnessOfFit',
  'regression.ols',
  'reliability.cronbachAlpha',
  /*
   * The rank-based tests, built after the recommender had been naming them for
   * some time. Until now a researcher whose normality assumption failed on a
   * small sample was told exactly which test they needed and that it did not
   * exist — correct, and no help at all.
   */
  'nonparametric.mannWhitney',
  'nonparametric.wilcoxon',
  'nonparametric.kruskalWallis',
]);

/**
 * Below this, the ordinal-versus-interval distinction bites.
 *
 * Treating Likert responses as interval quantities is defensible at large n —
 * the central limit theorem carries the mean of a bounded discrete variable a
 * long way — and indefensible at small n, where the shape of the distribution
 * still drives the result. Thirty is the conventional line and is used here for
 * the same reason it is used for the normality decision: consistency across the
 * product beats precision that nobody agrees on anyway.
 */
const ORDINAL_TOLERANCE_N = 30;

/** Scales that can be averaged without apology. */
const QUANTITATIVE: ReadonlySet<MeasurementScale> = new Set<MeasurementScale>(['interval', 'ratio']);

/* -------------------------------------------------------------------------- */
/*                              The recommender                               */
/* -------------------------------------------------------------------------- */

export function recommendTest(profile: DatasetProfile, roles: RoleAssignment[]): Recommendation {
  const blockers: Recommendation['blockers'] = [];
  const candidates: TestCandidate[] = [];

  const find = (name: string): ColumnProfile | undefined =>
    profile.columns.find((column) => column.name === name);

  const resolved = roles
    .map((assignment) => ({ assignment, column: find(assignment.column) }))
    .filter((entry): entry is { assignment: RoleAssignment; column: ColumnProfile } => {
      if (!entry.column) {
        blockers.push({ code: 'unknown-column', params: { column: entry.assignment.column } });
        return false;
      }
      return true;
    });

  const dependents = resolved.filter((entry) => entry.assignment.role === 'dependent');
  const groupings = resolved.filter((entry) => entry.assignment.role === 'grouping');
  const independents = resolved.filter(
    (entry) => entry.assignment.role === 'independent' || entry.assignment.role === 'covariate',
  );
  const paired = resolved.filter((entry) => entry.assignment.role === 'paired');

  const n = profile.rowCount;

  const basis: Recommendation['basis'] = {
    dependent: dependents[0]
      ? {
          column: dependents[0].column.name,
          scale: dependents[0].column.scale,
          type: dependents[0].column.type,
        }
      : null,
    grouping: groupings[0]
      ? { column: groupings[0].column.name, levels: groupings[0].column.distinct }
      : null,
    independents: independents.map((entry) => ({
      column: entry.column.name,
      scale: entry.column.scale,
      type: entry.column.type,
    })),
    n,
  };

  /* ------------------------------ sanity checks --------------------------- */

  if (dependents.length === 0 && paired.length !== 2 && independents.length < 2) {
    blockers.push({ code: 'no-dependent-variable' });
    return { candidates, best: null, basis, blockers };
  }

  if (dependents.length > 1) {
    blockers.push({ code: 'multiple-dependent-variables', params: { count: dependents.length } });
    return { candidates, best: null, basis, blockers };
  }

  const constant = resolved.filter((entry) => entry.column.constant);
  if (constant.length > 0) {
    blockers.push({
      code: 'constant-variable',
      params: { column: constant.map((entry) => entry.column.name).join(', ') },
    });
  }

  /* ---------------------------- paired designs ---------------------------- */

  if (paired.length === 2) {
    const [first, second] = paired as [typeof paired[0], typeof paired[0]];
    const bothQuantitative =
      isQuantitativeEnough(first.column, n) && isQuantitativeEnough(second.column, n);

    candidates.push(
      make('t.paired', bothQuantitative ? 'recommended' : 'possible', [
        { code: 'two-measurements-same-cases' },
        bothQuantitative
          ? { code: 'both-measurements-quantitative' }
          : { code: 'measurements-ordinal-small-sample', params: { n, threshold: ORDINAL_TOLERANCE_N } },
      ], [
        { code: 'assumes-normal-differences' },
        { code: 'requires-complete-pairs' },
      ]),
    );

    if (!bothQuantitative) {
      candidates.push(
        make('nonparametric.wilcoxon', 'recommended', [
          { code: 'ordinal-paired-data' },
          { code: 'no-normality-assumption' },
        ], []),
      );
    }

    return finish(candidates, basis, blockers);
  }

  /* -------------------------- no dependent, two+ predictors --------------- */

  if (dependents.length === 0) {
    // Two quantitative variables with no stated outcome: a correlation.
    const quantitative = independents.filter((entry) => isQuantitativeEnough(entry.column, n));

    if (independents.length >= 2) {
      const allQuantitative = quantitative.length === independents.length;
      const allOrdinalOrBetter = independents.every(
        (entry) => entry.column.scale === 'ordinal' || QUANTITATIVE.has(entry.column.scale),
      );

      if (allQuantitative) {
        candidates.push(
          make('correlation.pearson', 'recommended', [
            { code: 'both-variables-quantitative' },
            { code: 'no-outcome-declared' },
          ], [
            { code: 'assumes-linear-relationship' },
            { code: 'sensitive-to-outliers' },
          ]),
        );
        candidates.push(
          make('correlation.spearman', 'possible', [
            { code: 'robust-alternative' },
            { code: 'no-linearity-assumption' },
          ], []),
        );
      } else if (allOrdinalOrBetter) {
        candidates.push(
          make('correlation.spearman', 'recommended', [
            { code: 'ordinal-variable-present' },
            { code: 'ranks-respect-measurement-scale' },
          ], []),
        );
        candidates.push(
          make('correlation.pearson', 'possible', [
            { code: 'common-in-practice-for-likert' },
          ], [
            { code: 'treats-ordinal-as-interval' },
          ]),
        );
      } else {
        // Two categorical variables: a contingency table.
        const allCategorical = independents.every((entry) => entry.column.scale === 'nominal');
        if (allCategorical && independents.length === 2) {
          candidates.push(
            make('chiSquare.independence', 'recommended', [
              { code: 'both-variables-categorical' },
            ], [
              { code: 'requires-expected-counts-of-five' },
            ]),
          );
        } else {
          blockers.push({ code: 'mixed-scales-no-outcome' });
        }
      }
    }

    return finish(candidates, basis, blockers);
  }

  /* ------------------------------ one dependent --------------------------- */

  const dependent = (dependents[0] as { column: ColumnProfile }).column;
  const dependentQuantitative = isQuantitativeEnough(dependent, n);
  const dependentOrdinal = dependent.scale === 'ordinal';
  const dependentNominal = dependent.scale === 'nominal';

  /* --- categorical outcome: chi-square is the only thing implemented ------ */

  if (dependentNominal) {
    if (groupings.length === 1 || independents.length === 1) {
      const other = (groupings[0] ?? independents[0]) as { column: ColumnProfile };
      if (other.column.scale === 'nominal') {
        candidates.push(
          make('chiSquare.independence', 'recommended', [
            { code: 'categorical-outcome-and-predictor' },
          ], [
            { code: 'requires-expected-counts-of-five' },
          ]),
        );
      } else {
        /*
         * A categorical outcome with a quantitative predictor is a logistic
         * regression. Naming it while marking it unavailable is the honest
         * answer — the alternative is recommending a linear regression, which
         * would fit a straight line to a variable that only takes two values.
         */
        candidates.push(
          make('regression.ols', 'not-applicable', [
            { code: 'outcome-is-categorical' },
          ], [
            { code: 'logistic-regression-needed-not-implemented' },
          ]),
        );
        blockers.push({ code: 'logistic-regression-not-implemented' });
      }
    } else if (groupings.length === 0 && independents.length === 0) {
      candidates.push(
        make('chiSquare.goodnessOfFit', 'recommended', [
          { code: 'one-categorical-variable' },
          { code: 'tests-against-expected-distribution' },
        ], [
          { code: 'requires-expected-counts-of-five' },
        ]),
      );
    }

    return finish(candidates, basis, blockers);
  }

  /* --- quantitative or ordinal outcome ------------------------------------ */

  const grouping = groupings[0];

  if (grouping) {
    const levels = grouping.column.distinct;

    if (levels < 2) {
      blockers.push({
        code: 'grouping-has-one-level',
        params: { column: grouping.column.name },
      });
      return finish(candidates, basis, blockers);
    }

    if (levels === 2) {
      candidates.push(
        make('t.independent', dependentQuantitative ? 'recommended' : 'possible', [
          { code: 'two-independent-groups', params: { column: grouping.column.name } },
          dependentQuantitative
            ? { code: 'outcome-quantitative' }
            : { code: 'outcome-ordinal-large-sample', params: { n, threshold: ORDINAL_TOLERANCE_N } },
          { code: 'welch-form-used-by-default' },
        ], [
          { code: 'assumes-normal-within-groups' },
          { code: 'check-group-sizes' },
        ]),
      );

      if (!dependentQuantitative) {
        candidates.push(
          make('nonparametric.mannWhitney', 'recommended', [
            { code: 'ordinal-outcome' },
            { code: 'no-normality-assumption' },
          ], []),
        );
      }
    } else {
      candidates.push(
        make('anova.oneWay', dependentQuantitative ? 'recommended' : 'possible', [
          { code: 'three-or-more-groups', params: { levels, column: grouping.column.name } },
          dependentQuantitative
            ? { code: 'outcome-quantitative' }
            : { code: 'outcome-ordinal-large-sample', params: { n, threshold: ORDINAL_TOLERANCE_N } },
          { code: 'post-hoc-comparisons-included' },
        ], [
          { code: 'assumes-normal-within-groups' },
          { code: 'assumes-equal-variances-for-post-hoc' },
        ]),
      );

      if (!dependentQuantitative) {
        candidates.push(
          make('nonparametric.kruskalWallis', 'recommended', [
            { code: 'ordinal-outcome' },
            { code: 'no-normality-assumption' },
          ], []),
        );
      }

      /*
       * Pairwise t-tests are what a researcher will otherwise reach for, and
       * they are the wrong answer. Listed explicitly as not-applicable so the
       * interface can say why rather than leaving the option unmentioned.
       */
      candidates.push(
        make('t.independent', 'not-applicable', [
          { code: 'more-than-two-groups', params: { levels } },
        ], [
          { code: 'pairwise-tests-inflate-error-rate', params: { comparisons: (levels * (levels - 1)) / 2 } },
        ]),
      );
    }

    return finish(candidates, basis, blockers);
  }

  /* --- quantitative outcome with quantitative predictors ------------------ */

  if (independents.length >= 1) {
    const quantitativePredictors = independents.filter((entry) => isQuantitativeEnough(entry.column, n));
    const allQuantitative = quantitativePredictors.length === independents.length;

    if (allQuantitative || independents.every((entry) => entry.column.scale === 'ordinal')) {
      const casesPerPredictor = n / independents.length;

      candidates.push(
        make('regression.ols', casesPerPredictor >= 10 ? 'recommended' : 'possible', [
          {
            code: independents.length === 1 ? 'one-predictor-declared' : 'several-predictors-declared',
            params: { predictors: independents.length },
          },
          { code: 'outcome-quantitative' },
          ...(casesPerPredictor < 10
            ? [{ code: 'few-cases-per-predictor', params: { ratio: Number(casesPerPredictor.toFixed(1)) } }]
            : []),
        ], [
          { code: 'assumes-linear-relationship' },
          ...(independents.length > 1 ? [{ code: 'check-multicollinearity' }] : []),
          { code: 'assumptions-checked-on-residuals' },
        ]),
      );

      if (independents.length === 1) {
        const predictor = (independents[0] as { column: ColumnProfile }).column;
        const bothQuantitative = dependentQuantitative && isQuantitativeEnough(predictor, n);

        candidates.push(
          make('correlation.pearson', bothQuantitative ? 'recommended' : 'possible', [
            { code: 'strength-of-association-without-direction' },
          ], [
            { code: 'does-not-give-prediction-equation' },
          ]),
        );

        if (!bothQuantitative || dependentOrdinal || predictor.scale === 'ordinal') {
          candidates.push(
            make('correlation.spearman', 'recommended', [
              { code: 'ordinal-variable-present' },
              { code: 'ranks-respect-measurement-scale' },
            ], []),
          );
        }
      }
    } else {
      blockers.push({ code: 'categorical-predictor-needs-grouping-role' });
    }

    return finish(candidates, basis, blockers);
  }

  /* --- a single quantitative variable ------------------------------------- */

  candidates.push(
    make('t.oneSample', dependentQuantitative || dependentOrdinal ? 'recommended' : 'not-applicable', [
      { code: 'single-variable-against-fixed-value' },
      ...(dependentOrdinal ? [{ code: 'likert-midpoint-comparison' }] : []),
    ], [
      { code: 'comparison-value-must-be-supplied' },
      { code: 'assumes-normal-distribution' },
    ]),
  );

  return finish(candidates, basis, blockers);
}

/* -------------------------------------------------------------------------- */
/*                               Scale reliability                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a set of columns looks like a scale whose reliability is worth
 * checking before anything else is done with it.
 *
 * Separate from `recommendTest` because it answers a different question: not
 * "which test compares these variables" but "should these variables be
 * combined into one score at all". It is the first thing to run on
 * questionnaire data, and running it after the analysis rather than before is
 * how a thesis ends up reporting results from an instrument that does not hold
 * together.
 */
export function shouldCheckReliability(
  profile: DatasetProfile,
  columnNames: string[],
): { recommended: boolean; reasons: { code: string; params?: Record<string, string | number> }[] } {
  const reasons: { code: string; params?: Record<string, string | number> }[] = [];

  const columns = columnNames
    .map((name) => profile.columns.find((column) => column.name === name))
    .filter((column): column is ColumnProfile => column !== undefined);

  if (columns.length < 2) {
    return { recommended: false, reasons: [{ code: 'fewer-than-two-items' }] };
  }

  const likert = columns.filter((column) => column.type === 'likert');
  const binary = columns.filter((column) => column.type === 'binary');

  if (likert.length === columns.length) {
    reasons.push({ code: 'all-items-are-likert', params: { items: columns.length } });
    return { recommended: true, reasons };
  }

  if (binary.length === columns.length) {
    reasons.push({ code: 'all-items-binary-kr20', params: { items: columns.length } });
    return { recommended: true, reasons };
  }

  if (likert.length >= 2) {
    reasons.push({
      code: 'some-items-are-likert',
      params: { likert: likert.length, total: columns.length },
    });
    return { recommended: true, reasons };
  }

  reasons.push({ code: 'items-do-not-look-like-a-scale' });
  return { recommended: false, reasons };
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a column may be treated as a quantity.
 *
 * Interval and ratio always may. An ordinal column may when the sample is large
 * enough that the mean of a bounded discrete variable is well behaved — which
 * is the pragmatic position most of the applied literature has settled on, and
 * a good deal more defensible than either extreme of "never" or "always".
 */
function isQuantitativeEnough(column: ColumnProfile, n: number): boolean {
  if (QUANTITATIVE.has(column.scale)) return true;
  if (column.scale === 'ordinal') return n >= ORDINAL_TOLERANCE_N;
  return false;
}

function make(
  test: TestKey,
  confidence: RecommendationConfidence,
  reasons: TestCandidate['reasons'],
  caveats: TestCandidate['caveats'],
): TestCandidate {
  return { test, confidence, reasons, caveats, available: IMPLEMENTED.has(test) };
}

function finish(
  candidates: TestCandidate[],
  basis: Recommendation['basis'],
  blockers: Recommendation['blockers'],
): Recommendation {
  /*
   * Ordered so that anything the researcher can actually run comes first. A
   * recommended-but-unimplemented test still appears — that is the point of
   * naming Mann–Whitney before it exists — but it never outranks a usable one,
   * because a recommendation nobody can act on is not a recommendation.
   */
  const rank: Record<RecommendationConfidence, number> = {
    recommended: 0,
    possible: 1,
    'not-applicable': 2,
  };

  const sorted = [...candidates].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return rank[a.confidence] - rank[b.confidence];
  });

  const best = sorted.find((candidate) => candidate.available && candidate.confidence === 'recommended') ?? null;

  if (!best && blockers.length === 0 && sorted.length === 0) {
    blockers.push({ code: 'no-test-matches-these-variables' });
  }

  return { candidates: sorted, best, basis, blockers };
}
