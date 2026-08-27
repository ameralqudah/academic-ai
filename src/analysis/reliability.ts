/**
 * Scale reliability — Cronbach's alpha.
 *
 * This is the first thing a supervisor asks for in any study that measures an
 * attitude, and the first number a student reports without understanding. The
 * implementation therefore does more than return a coefficient: it refuses
 * input the coefficient does not apply to, states what it did with missing
 * data, and names the specific conditions under which the number it just
 * produced should not be believed.
 *
 * Three decisions carry the design.
 *
 * **Measurement scale is enforced, not assumed.** Alpha describes a set of
 * items that are summed into one score. Averaging a Likert item with a
 * respondent's monthly income is arithmetically possible and substantively
 * meaningless, so the column types inferred during profiling decide what may
 * enter the scale. This is the same `MeasurementScale` logic the profiler
 * already uses; nothing here re-guesses it.
 *
 * **Missing values are deleted listwise, loudly.** A respondent who skipped one
 * item of twenty contributes nothing to a covariance that needs all twenty, and
 * imputing their answer would invent data. So the row is dropped — and the
 * count of dropped rows is part of the result, not a footnote, because alpha
 * computed on 40 of 300 respondents is a different claim from alpha on 300.
 *
 * **A high alpha is not automatically good news.** Alpha rises with the number
 * of items regardless of whether they measure one thing, so a twenty-item scale
 * at 0.95 may be twenty rewordings of one question rather than a reliable
 * instrument. The result carries that warning where it applies.
 */

import { fQuantile } from './distributions';
import { DataParseError } from './parse';
import { mean, pearson, toNumber, variance } from './stats-core';
import type { CellValue, ColumnProfile, Dataset, DatasetProfile } from './types';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * How the coefficient should be read. The cut points are the convention in
 * educational and social research (Nunnally; George & Mallery), and the labels
 * are keys rather than sentences so the UI can say them in either language.
 */
export type ReliabilityBand =
  | 'excellent'
  | 'good'
  | 'acceptable'
  | 'questionable'
  | 'poor'
  | 'unacceptable';

export type ReliabilityWarningCode =
  | 'negative-alpha'
  | 'reverse-coded-item'
  | 'constant-item'
  | 'very-small-sample'
  | 'small-sample'
  | 'two-items-only'
  | 'many-items'
  | 'listwise-deletion'
  | 'heavy-listwise-deletion'
  | 'mixed-item-types'
  | 'unequal-item-spread'
  | 'possible-redundancy'
  | 'weak-item';

export interface ReliabilityWarning {
  code: ReliabilityWarningCode;
  severity: 'info' | 'warning' | 'error';
  /** Columns this concerns. Empty when it is about the scale as a whole. */
  columns: string[];
  /** Numbers for the message, formatted by the UI in the user's locale. */
  params?: Record<string, string | number>;
}

export interface ReliabilityItem {
  name: string;
  mean: number;
  sd: number;
  variance: number;
  /**
   * Corrected item-total correlation: this item against the sum of the *other*
   * items. Uncorrected — item against a total that includes itself — is
   * inflated by construction, and is the version that hides a bad item.
   */
  itemTotalCorrelation: number;
  /** Alpha for the scale with this item removed. Higher means the item hurts. */
  alphaIfDeleted: number;
  constant: boolean;
}

export interface ReliabilityResult {
  alpha: number;
  /**
   * Alpha computed from the correlation matrix instead of the covariance
   * matrix. It is the figure to report when items use different response
   * ranges, because raw alpha lets the widest item dominate the total variance.
   */
  standardisedAlpha: number;
  band: ReliabilityBand;

  itemCount: number;
  /** Respondents actually used, after listwise deletion. */
  sampleSize: number;
  rowsSupplied: number;
  rowsDropped: number;

  scaleMean: number;
  scaleVariance: number;
  sumItemVariances: number;
  averageInterItemCorrelation: number;

  /** Feldt's interval. Null when alpha is not positive, where it has no meaning. */
  confidenceInterval: { level: number; lower: number; upper: number } | null;

  items: ReliabilityItem[];
  warnings: ReliabilityWarning[];
}

export interface ReliabilityOptions {
  /** Defaults to 0.95. */
  confidenceLevel?: number;
}

/* -------------------------------------------------------------------------- */
/*                             Input validation                               */
/* -------------------------------------------------------------------------- */

/**
 * Column types that may take part in a summed scale.
 *
 * `likert` is the intended case. `binary` is admitted because alpha over
 * dichotomous items is exactly the Kuder–Richardson KR-20 formula, which is the
 * correct coefficient for a right/wrong test. `integer` and `numeric` are
 * admitted with a warning: they are legitimate for count or continuous
 * indicators of one construct, but they are also how an ID or an age column
 * gets dragged into a scale by a careless selection.
 */
const SCALE_ELIGIBLE_TYPES = new Set(['likert', 'binary', 'integer', 'numeric']);

/** Types that are never part of a summed scale, whatever the user selected. */
function rejectIneligible(profile: ColumnProfile): void {
  if (profile.type === 'empty') {
    throw new DataParseError('analysis.reliability.error.emptyColumn', { column: profile.name });
  }
  if (!SCALE_ELIGIBLE_TYPES.has(profile.type)) {
    throw new DataParseError('analysis.reliability.error.notNumericColumn', {
      column: profile.name,
      type: profile.type,
    });
  }
  /*
   * A `binary` column may hold "yes"/"no" or "ذكر"/"أنثى" rather than 0/1. The
   * profiler classifies both as binary because both have two levels, but only
   * the numeric form can be summed. The values are checked below; this guard
   * catches the nominal case early with a message that names the column.
   */
  if (profile.scale === 'nominal' && profile.type !== 'binary') {
    throw new DataParseError('analysis.reliability.error.nominalColumn', { column: profile.name });
  }
}

/* -------------------------------------------------------------------------- */
/*                              Cronbach's alpha                              */
/* -------------------------------------------------------------------------- */

/**
 * α = (k / (k − 1)) · (1 − Σ s²ᵢ / s²_total)
 *
 * Sample variances throughout (n − 1). The population form would make alpha
 * disagree with SPSS, R and every table in the literature the student is
 * comparing against, and a coefficient that does not reproduce is worse than no
 * coefficient at all.
 */
export function cronbachAlpha(
  dataset: Dataset,
  profile: DatasetProfile,
  columnNames: string[],
  options: ReliabilityOptions = {},
): ReliabilityResult {
  const level = options.confidenceLevel ?? 0.95;

  /* ------------------------------------------------------------- selection */

  if (columnNames.length < 2) {
    throw new DataParseError('analysis.reliability.error.tooFewItems', {
      selected: columnNames.length,
    });
  }

  const unique = new Set(columnNames);
  if (unique.size !== columnNames.length) {
    throw new DataParseError('analysis.reliability.error.duplicateItem');
  }

  const chosen = columnNames.map((name) => {
    const column = profile.columns.find((entry) => entry.name === name);
    if (!column) {
      throw new DataParseError('analysis.reliability.error.unknownColumn', { column: name });
    }
    rejectIneligible(column);
    return column;
  });

  /* ------------------------------------------------- listwise deletion */

  const indices = chosen.map((column) => column.index);
  const rows: number[][] = [];
  let dropped = 0;

  for (const row of dataset.rows) {
    const values: number[] = [];
    let complete = true;

    for (const index of indices) {
      const parsed = numberAt(row[index]);
      if (parsed === null) {
        complete = false;
        break;
      }
      values.push(parsed);
    }

    if (complete) rows.push(values);
    else dropped += 1;
  }

  const n = rows.length;
  const k = chosen.length;

  if (n < 2) {
    throw new DataParseError('analysis.reliability.error.tooFewRespondents', {
      usable: n,
      supplied: dataset.rows.length,
    });
  }

  /* ------------------------------------------------------------ the sums */

  const itemValues: number[][] = chosen.map((_, column) => rows.map((row) => row[column] as number));
  const itemVariances = itemValues.map((values) => variance(values));
  const itemMeans = itemValues.map((values) => mean(values));
  const totals = rows.map((row) => row.reduce((sum, value) => sum + value, 0));

  const scaleVariance = variance(totals);
  const sumItemVariances = itemVariances.reduce((sum, value) => sum + value, 0);

  if (scaleVariance === 0) {
    throw new DataParseError('analysis.reliability.error.noVariance');
  }

  const alpha = (k / (k - 1)) * (1 - sumItemVariances / scaleVariance);

  /* ---------------------------------------------- correlations and items */

  const correlations: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(Number.NaN));
  for (let i = 0; i < k; i += 1) {
    correlations[i]![i] = 1;
    for (let j = i + 1; j < k; j += 1) {
      const r = pearson(itemValues[i] as number[], itemValues[j] as number[]);
      correlations[i]![j] = r;
      correlations[j]![i] = r;
    }
  }

  const offDiagonal: number[] = [];
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const r = correlations[i]![j] as number;
      if (Number.isFinite(r)) offDiagonal.push(r);
    }
  }

  const averageInterItemCorrelation = offDiagonal.length > 0 ? mean(offDiagonal) : Number.NaN;

  /*
   * Standardised alpha via the Spearman–Brown form. Equivalent to alpha on the
   * correlation matrix, and computed this way so that a constant item — which
   * has no correlation with anything — is excluded from the average rather than
   * silently counted as zero.
   */
  const standardisedAlpha = Number.isFinite(averageInterItemCorrelation)
    ? (k * averageInterItemCorrelation) / (1 + (k - 1) * averageInterItemCorrelation)
    : Number.NaN;

  const items: ReliabilityItem[] = chosen.map((column, i) => {
    const values = itemValues[i] as number[];
    const rest = rows.map((row) =>
      row.reduce((sum, value, index) => (index === i ? sum : sum + value), 0),
    );

    return {
      name: column.name,
      mean: itemMeans[i] as number,
      sd: Math.sqrt(itemVariances[i] as number),
      variance: itemVariances[i] as number,
      itemTotalCorrelation: pearson(values, rest),
      alphaIfDeleted: alphaWithout(itemValues, i),
      constant: (itemVariances[i] as number) === 0,
    };
  });

  /* ----------------------------------------------------------- interval */

  const confidenceInterval = feldtInterval(alpha, n, k, level);

  /* ----------------------------------------------------------- warnings */

  const warnings = collectWarnings({
    alpha,
    items,
    chosen,
    n,
    k,
    dropped,
    supplied: dataset.rows.length,
    itemVariances,
  });

  return {
    alpha,
    standardisedAlpha,
    band: bandForAlpha(alpha),
    itemCount: k,
    sampleSize: n,
    rowsSupplied: dataset.rows.length,
    rowsDropped: dropped,
    scaleMean: mean(totals),
    scaleVariance,
    sumItemVariances,
    averageInterItemCorrelation,
    confidenceInterval,
    items,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * A cell becomes a number or it becomes missing.
 *
 * `toNumber` already understands Arabic-Indic digits, the Arabic decimal
 * separator and spreadsheet formatting. What it will not do is turn "لا أوافق"
 * into a 1 — mapping labels onto a numeric scale is a decision about the
 * instrument, and it belongs to the researcher, not to this function.
 */
function numberAt(value: CellValue | undefined): number | null {
  if (value === undefined || value === null) return null;
  return toNumber(value);
}

/** Alpha for the scale with item `omit` removed. Used for "alpha if deleted". */
function alphaWithout(itemValues: number[][], omit: number): number {
  const kept = itemValues.filter((_, index) => index !== omit);
  const k = kept.length;
  if (k < 2) return Number.NaN;

  const rowCount = kept[0]?.length ?? 0;
  const totals = new Array<number>(rowCount).fill(0);
  for (const values of kept) {
    for (let row = 0; row < rowCount; row += 1) {
      totals[row] = (totals[row] as number) + (values[row] as number);
    }
  }

  const total = variance(totals);
  if (total === 0) return Number.NaN;

  const sumVariances = kept.reduce((sum, values) => sum + variance(values), 0);
  return (k / (k - 1)) * (1 - sumVariances / total);
}

/**
 * Feldt's confidence interval for alpha.
 *
 * Alpha is a ratio of variances, so its sampling distribution is an F, not a
 * normal — which is why the interval is asymmetric and why the usual
 * estimate ± 1.96·SE construction does not apply. Reported because a point
 * estimate of 0.71 from 25 respondents and one from 400 are not the same
 * finding, and only the interval shows it.
 */
function feldtInterval(
  alpha: number,
  n: number,
  k: number,
  level: number,
): { level: number; lower: number; upper: number } | null {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return null;
  if (n < 3 || k < 2) return null;

  const tail = (1 - level) / 2;
  const df1 = n - 1;
  const df2 = (n - 1) * (k - 1);

  const upperF = fQuantile(1 - tail, df1, df2);
  const lowerF = fQuantile(tail, df1, df2);
  if (!Number.isFinite(upperF) || !Number.isFinite(lowerF)) return null;

  return {
    level,
    lower: 1 - (1 - alpha) * upperF,
    upper: 1 - (1 - alpha) * lowerF,
  };
}

/** The conventional reading of the coefficient. */
export function bandForAlpha(alpha: number): ReliabilityBand {
  if (!Number.isFinite(alpha)) return 'unacceptable';
  if (alpha >= 0.9) return 'excellent';
  if (alpha >= 0.8) return 'good';
  if (alpha >= 0.7) return 'acceptable';
  if (alpha >= 0.6) return 'questionable';
  if (alpha >= 0.5) return 'poor';
  return 'unacceptable';
}

function collectWarnings(input: {
  alpha: number;
  items: ReliabilityItem[];
  chosen: ColumnProfile[];
  n: number;
  k: number;
  dropped: number;
  supplied: number;
  itemVariances: number[];
}): ReliabilityWarning[] {
  const { alpha, items, chosen, n, k, dropped, supplied, itemVariances } = input;
  const warnings: ReliabilityWarning[] = [];

  /*
   * A negative alpha is not a weak scale, it is a broken one. It happens when
   * the average covariance between items is negative, and in practice that has
   * one overwhelming cause: a reverse-worded item ("I find this subject
   * boring") left un-recoded among positively worded ones. Reported as an error
   * because the correct response is to fix the data, not to report the number.
   */
  if (alpha < 0) {
    warnings.push({ code: 'negative-alpha', severity: 'error', columns: [], params: { alpha } });
  }

  const reversed = items.filter(
    (item) => Number.isFinite(item.itemTotalCorrelation) && item.itemTotalCorrelation < 0,
  );
  if (reversed.length > 0) {
    warnings.push({
      code: 'reverse-coded-item',
      severity: 'error',
      columns: reversed.map((item) => item.name),
      params: { count: reversed.length },
    });
  }

  const constant = items.filter((item) => item.constant);
  if (constant.length > 0) {
    warnings.push({
      code: 'constant-item',
      severity: 'warning',
      columns: constant.map((item) => item.name),
      params: { count: constant.length },
    });
  }

  /*
   * An item correlating below .30 with the rest of the scale is the standard
   * threshold for "this item is measuring something else". Not an error — the
   * decision to drop an item is the researcher's — but it is the single most
   * useful thing this function can point at.
   */
  const weak = items.filter(
    (item) =>
      !item.constant &&
      Number.isFinite(item.itemTotalCorrelation) &&
      item.itemTotalCorrelation >= 0 &&
      item.itemTotalCorrelation < 0.3,
  );
  if (weak.length > 0) {
    warnings.push({
      code: 'weak-item',
      severity: 'info',
      columns: weak.map((item) => item.name),
      params: { count: weak.length, threshold: 0.3 },
    });
  }

  if (n < 10) {
    warnings.push({ code: 'very-small-sample', severity: 'error', columns: [], params: { n } });
  } else if (n < 30) {
    warnings.push({ code: 'small-sample', severity: 'warning', columns: [], params: { n } });
  }

  /*
   * Two items give alpha its least stable form: with a single covariance to
   * work from, the coefficient swings widely between samples. The
   * Spearman–Brown coefficient is the conventional alternative for a two-item
   * scale.
   */
  if (k === 2) {
    warnings.push({ code: 'two-items-only', severity: 'warning', columns: [], params: {} });
  }

  /*
   * Alpha increases with the number of items whether or not they are coherent,
   * so a long scale clearing 0.7 says less than a short one doing the same.
   */
  if (k > 20) {
    warnings.push({ code: 'many-items', severity: 'info', columns: [], params: { k } });
  }

  if (dropped > 0) {
    const percent = supplied === 0 ? 0 : (dropped / supplied) * 100;
    warnings.push({
      code: percent > 20 ? 'heavy-listwise-deletion' : 'listwise-deletion',
      severity: percent > 20 ? 'warning' : 'info',
      columns: [],
      params: { dropped, supplied, percent: Number(percent.toFixed(1)), used: n },
    });
  }

  /*
   * Alpha assumes the items belong to one instrument. Mixing a Likert item with
   * a continuous measure is the arithmetic working while the meaning does not.
   */
  const types = new Set(chosen.map((column) => column.type));
  if (types.size > 1) {
    warnings.push({
      code: 'mixed-item-types',
      severity: 'warning',
      columns: chosen.map((column) => column.name),
      params: { types: [...types].sort().join(', ') },
    });
  }

  /*
   * Raw alpha weights each item by its variance, so one item on a 0–100 range
   * among five-point items effectively becomes the scale. Standardised alpha is
   * the answer, and it is already in the result — this points the user at it.
   */
  const spreads = itemVariances.map((value) => Math.sqrt(value)).filter((value) => value > 0);
  if (spreads.length >= 2) {
    const widest = Math.max(...spreads);
    const narrowest = Math.min(...spreads);
    if (widest / narrowest > 2) {
      warnings.push({
        code: 'unequal-item-spread',
        severity: 'warning',
        columns: [],
        params: { ratio: Number((widest / narrowest).toFixed(2)) },
      });
    }
  }

  /*
   * Very high alpha usually means redundancy rather than excellence: items that
   * are paraphrases of each other, measuring the same narrow thing repeatedly.
   */
  if (alpha >= 0.95) {
    warnings.push({ code: 'possible-redundancy', severity: 'info', columns: [], params: { alpha } });
  }

  return warnings;
}
