/**
 * Checking the data before the model runs.
 *
 * The schema already validates the model's *structure* — a cycle, an indicator
 * in two constructs, a construct with no items. All of that can be checked
 * without looking at a single number.
 *
 * This checks the numbers. An indicator where every respondent gave the same
 * answer, two items that are the same variable under different names, a
 * construct measured by fewer complete cases than it has indicators. Each of
 * those makes the estimation either fail or produce something meaningless, and
 * each is knowable in milliseconds before a minute of bootstrapping is spent
 * discovering it.
 *
 * **The severity distinction is the point.** A zero-variance indicator makes the
 * correlation matrix singular and the model cannot run: that is an error. Two
 * indicators correlating at 0.96 will estimate fine and produce weights nobody
 * can interpret: that is a warning, and the researcher decides. Conflating them
 * would either block a legitimate model or let a broken one through.
 *
 * Nothing here removes an indicator or alters the model. It reports.
 */

import { pearson, standardDeviation } from '../../stats-core';

import type { PlsModel } from './schema';

/** Above this, two indicators are close enough to be the same variable. */
const REDUNDANT_CORRELATION = 0.95;
/** Above this, worth flagging as collinear without being redundant. */
const HIGH_CORRELATION = 0.9;
/** Cases per indicator, below which estimates are unstable. */
const MIN_CASES_PER_INDICATOR = 5;
/** The floor every PLS text gives, regardless of model size. */
const MIN_CASES_ABSOLUTE = 30;

export type CheckSeverity = 'error' | 'warning';

export interface DataIssue {
  key: string;
  severity: CheckSeverity;
  /** Which columns the issue concerns, for highlighting them in the builder. */
  columns: string[];
  params?: Record<string, string | number>;
}

export interface DataCheckResult {
  issues: DataIssue[];
  /** False when any issue is an error — the model cannot be estimated. */
  canEstimate: boolean;
  /** Complete cases across every modelled indicator. */
  completeCases: number;
}

/**
 * Runs every data check for a model.
 *
 * Returns all the problems rather than the first, because a researcher fixing
 * them one at a time is being made to submit repeatedly for information that
 * was available at once.
 */
export function checkModelData(
  model: PlsModel,
  data: Map<string, number[]>,
): DataCheckResult {
  const issues: DataIssue[] = [];
  const indicators = model.constructs.flatMap((construct) => construct.indicators);

  /* Missing columns first: everything else would compute on absent data. */
  const missing = indicators.filter((indicator) => !data.has(indicator));

  if (missing.length > 0) {
    return {
      issues: [{ key: 'missingColumns', severity: 'error', columns: missing }],
      canEstimate: false,
      completeCases: 0,
    };
  }

  const completeRows = completeCaseIndices(indicators, data);
  const n = completeRows.length;

  /* Sample size, against both the absolute floor and the model's own size. */
  const required = Math.max(MIN_CASES_ABSOLUTE, indicators.length * MIN_CASES_PER_INDICATOR);

  if (n < MIN_CASES_ABSOLUTE) {
    issues.push({
      key: 'tooFewCases',
      severity: 'error',
      columns: [],
      params: { n, minimum: MIN_CASES_ABSOLUTE },
    });
  } else if (n < required) {
    /*
     * A warning rather than an error: the estimation will run and the
     * coefficients will be unstable. That is a judgement about how much to
     * trust the result, which belongs to the researcher.
     */
    issues.push({
      key: 'fewCasesPerIndicator',
      severity: 'warning',
      columns: [],
      params: {
        n,
        indicators: indicators.length,
        ratio: Number((n / indicators.length).toFixed(1)),
        recommended: MIN_CASES_PER_INDICATOR,
      },
    });
  }

  /*
   * Missing data, reported as a proportion. Twelve dropped cases means
   * something different at n = 40 than at n = 400, and the count alone invites
   * the wrong reading.
   */
  const supplied = data.get(indicators[0] as string)?.length ?? 0;
  const dropped = supplied - n;

  if (dropped > 0) {
    const percent = Math.round((dropped / supplied) * 100);
    issues.push({
      key: 'missingData',
      severity: percent > 15 ? 'warning' : 'warning',
      columns: [],
      params: { dropped, percent },
    });
  }

  if (n === 0) {
    return { issues, canEstimate: false, completeCases: 0 };
  }

  /* Per-indicator checks, on complete cases only. */
  const columns = new Map<string, number[]>();

  for (const indicator of indicators) {
    const values = completeRows.map((row) => data.get(indicator)?.[row] as number);
    columns.set(indicator, values);

    const spread = standardDeviation(values);

    if (spread === 0 || !Number.isFinite(spread)) {
      /*
       * Every respondent gave the same answer. This is an error rather than a
       * warning because the correlation matrix becomes singular and there is
       * nothing to estimate — and it is worth naming precisely, since it
       * usually means a question everyone skipped or a column of constants left
       * in by an export.
       */
      issues.push({
        key: 'zeroVariance',
        severity: 'error',
        columns: [indicator],
      });
      continue;
    }

    /*
     * An indicator with very few distinct values is not broken, but it behaves
     * more like a category than a scale, and a construct built from such items
     * will produce loadings that are hard to interpret.
     */
    const distinct = new Set(values).size;
    if (distinct === 2) {
      issues.push({
        key: 'binaryIndicator',
        severity: 'warning',
        columns: [indicator],
      });
    }
  }

  /*
   * Pairwise collinearity, within each construct.
   *
   * Checked within rather than across, because two indicators of different
   * constructs correlating highly is a discriminant-validity finding that the
   * assessment reports properly with HTMT — not a data problem. Within a
   * construct it is a different matter: two items that are the same variable
   * split the weight between them arbitrarily.
   */
  for (const construct of model.constructs) {
    const usable = construct.indicators.filter((indicator) => {
      const values = columns.get(indicator);
      return values && standardDeviation(values) > 0;
    });

    for (let i = 0; i < usable.length; i += 1) {
      for (let j = i + 1; j < usable.length; j += 1) {
        const first = usable[i] as string;
        const second = usable[j] as string;
        const correlation = Math.abs(
          pearson(columns.get(first) as number[], columns.get(second) as number[]),
        );

        if (correlation >= REDUNDANT_CORRELATION) {
          /*
           * An error only where the matrix is genuinely singular.
           *
           * The threshold was 0.999, and two items differing by a little noise
           * correlate at 0.9998 — reported as 1.000 after rounding and blocked
           * as an error, when the model estimates without difficulty. Blocking a
           * researcher from a model that runs is worse than letting them see an
           * unstable weight, so only an exact duplicate is refused.
           */
          issues.push({
            key: 'redundantIndicators',
            severity: correlation >= 1 - 1e-9 ? 'error' : 'warning',
            columns: [first, second],
            params: { correlation: Number(correlation.toFixed(3)), construct: construct.name },
          });
        } else if (correlation >= HIGH_CORRELATION) {
          issues.push({
            key: 'highlyCorrelated',
            severity: 'warning',
            columns: [first, second],
            params: { correlation: Number(correlation.toFixed(3)), construct: construct.name },
          });
        }
      }
    }
  }

  /*
   * A reverse-worded item that was never recoded.
   *
   * Detected as an indicator correlating negatively with the rest of its own
   * construct. It is among the most common problems in real questionnaire data
   * and one of the least visible: the model estimates, the loading comes back
   * negative, and reliability collapses for a reason that looks statistical and
   * is editorial.
   */
  for (const construct of model.constructs) {
    if (construct.mode !== 'reflective' || construct.indicators.length < 3) continue;

    /*
     * Count the negative relationships each indicator has with its siblings.
     *
     * The naive version flagged every item involved: with three indicators
     * where one is reversed, all three have a majority of negative
     * correlations, so all three were reported. That tells a researcher their
     * whole scale is broken when one item is.
     *
     * The odd one out is the one with the *most* negative relationships, and
     * only when the others agree among themselves. With more than one genuinely
     * reversed item the picture is ambiguous, and reporting nothing is better
     * than naming the wrong one.
     */
    const negativeCounts = new Map<string, number>();

    for (const indicator of construct.indicators) {
      const values = columns.get(indicator);
      if (!values || standardDeviation(values) === 0) continue;

      let negative = 0;
      for (const other of construct.indicators) {
        if (other === indicator) continue;
        const otherValues = columns.get(other);
        if (!otherValues || standardDeviation(otherValues) === 0) continue;
        if (pearson(values, otherValues) < -0.1) negative += 1;
      }

      negativeCounts.set(indicator, negative);
    }

    const ranked = [...negativeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const worst = ranked[0];
    const runnerUp = ranked[1];

    /*
     * Reported only when one indicator stands clearly apart: it disagrees with
     * every sibling, and no other disagrees as widely. Two items tied at the
     * top means the reversal is not identifiable from the correlations alone.
     */
    if (
      worst &&
      worst[1] === construct.indicators.length - 1 &&
      (!runnerUp || runnerUp[1] < worst[1])
    ) {
      issues.push({
        key: 'possiblyReverseCoded',
        severity: 'warning',
        columns: [worst[0]],
        params: { construct: construct.name },
      });
    }
  }

  return {
    issues,
    canEstimate: !issues.some((issue) => issue.severity === 'error'),
    completeCases: n,
  };
}

function completeCaseIndices(indicators: string[], data: Map<string, number[]>): number[] {
  const length = data.get(indicators[0] as string)?.length ?? 0;
  const complete: number[] = [];

  for (let row = 0; row < length; row += 1) {
    let usable = true;
    for (const indicator of indicators) {
      const value = data.get(indicator)?.[row];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        usable = false;
        break;
      }
    }
    if (usable) complete.push(row);
  }

  return complete;
}

export { REDUNDANT_CORRELATION, HIGH_CORRELATION, MIN_CASES_PER_INDICATOR, MIN_CASES_ABSOLUTE };
