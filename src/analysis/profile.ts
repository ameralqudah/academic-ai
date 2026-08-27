import {
  kurtosis,
  mean,
  median,
  quantile,
  skewness,
  standardDeviation,
  toNumber,
  variance,
} from './stats-core';
import type {
  CategoryCount,
  CellValue,
  ColumnProfile,
  ColumnType,
  Dataset,
  DataIssue,
  DatasetProfile,
  MeasurementScale,
  NumericSummary,
} from './types';

/** Above this many distinct values, a column of text is text, not categories. */
const MAX_CATEGORIES = 25;
/** How many category rows the report carries; the rest is summarised as "other". */
const CATEGORY_REPORT_LIMIT = 12;
/** Row indices attached to an issue, for the user to go and look at. */
const SAMPLE_LIMIT = 8;
/** Below this, most of the tests this product offers are not defensible. */
const SMALL_SAMPLE = 30;

/**
 * Reads a dataset and describes it, without changing a single value.
 *
 * The profile is the input to two very different consumers: the cleaning
 * planner, which needs precise counts and row indices, and the researcher, who
 * needs to understand what is wrong with their file. Both are served by facts,
 * so nothing here is inferred by a language model — every number below is
 * counted, and every issue names the rows it is talking about.
 */
export function profileDataset(dataset: Dataset): DatasetProfile {
  const { columns, rows } = dataset;

  const columnProfiles = columns.map((name, index) => profileColumn(name, index, rows));
  const duplicateRows = findDuplicateRows(rows);
  const missingCells = columnProfiles.reduce((total, column) => total + column.missing, 0);
  const cells = rows.length * columns.length;

  const issues = collectIssues(dataset, columnProfiles, duplicateRows);

  return {
    source: dataset.source,
    rowCount: rows.length,
    columnCount: columns.length,
    columns: columnProfiles,
    issues,
    duplicateRows,
    missingCells,
    completeness: cells === 0 ? 0 : 1 - missingCells / cells,
    profiledAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Columns                                   */
/* -------------------------------------------------------------------------- */

function profileColumn(name: string, index: number, rows: CellValue[][]): ColumnProfile {
  const present: { value: CellValue; row: number }[] = [];
  let missing = 0;

  rows.forEach((row, rowIndex) => {
    const value = row[index] ?? null;
    if (value === null || value === '') missing += 1;
    else present.push({ value, row: rowIndex });
  });

  const texts = present.map((entry) => String(entry.value));
  // Inference reads the value as a human would — spacing is a formatting
  // accident, not evidence about what the column measures. The raw text is
  // still what gets counted and reported.
  const trimmed = texts.map((text) => text.trim());
  const distinct = new Set(texts).size;
  const distinctTrimmed = new Set(trimmed).size;

  const numbers: { value: number; row: number }[] = [];
  for (const entry of present) {
    const parsed = toNumber(entry.value);
    if (parsed !== null) numbers.push({ value: parsed, row: entry.row });
  }

  const numericShare = present.length === 0 ? 0 : numbers.length / present.length;
  const type = inferType(
    trimmed,
    numbers.map((entry) => entry.value),
    numericShare,
    distinctTrimmed,
    present.length,
  );
  const scale = scaleFor(type, distinctTrimmed);

  const profile: ColumnProfile = {
    name,
    index,
    type,
    scale,
    present: present.length,
    missing,
    missingPercent: rows.length === 0 ? 0 : (missing / rows.length) * 100,
    distinct,
    outlierRows: [],
    constant: present.length > 0 && distinct === 1,
  };

  if ((type === 'numeric' || type === 'integer' || type === 'likert') && numbers.length >= 2) {
    const values = numbers.map((entry) => entry.value);
    profile.numeric = summarise(values);

    // Likert and binary columns have bounded scales by construction: a value at
    // the end of a five-point scale is not an outlier, it is an opinion.
    if (type !== 'likert') {
      const { rows: outlierRows, rule } = findOutliers(numbers, profile.numeric);
      profile.outlierRows = outlierRows;
      if (outlierRows.length > 0) profile.outlierRule = rule;
    }
  }

  if (type === 'categorical' || type === 'binary' || type === 'likert' || type === 'text') {
    const counts = countCategories(texts);
    if (counts.length <= CATEGORY_REPORT_LIMIT) {
      profile.categories = counts;
    } else {
      profile.categories = counts.slice(0, CATEGORY_REPORT_LIMIT);
      profile.otherCount = counts
        .slice(CATEGORY_REPORT_LIMIT)
        .reduce((total, entry) => total + entry.count, 0);
    }
  }

  return profile;
}

function inferType(
  texts: string[],
  numbers: number[],
  numericShare: number,
  distinct: number,
  present: number,
): ColumnType {
  if (present === 0) return 'empty';

  const lowered = texts.map((text) => text.toLowerCase());
  const booleanWords = new Set(['true', 'false', 'yes', 'no', 'نعم', 'لا', 'ذكر', 'أنثى', 'male', 'female']);
  if (distinct === 2 && lowered.every((text) => booleanWords.has(text))) return 'binary';

  // A column is numeric only when nearly all of it parses. A 90% threshold
  // keeps a stray "N/A" from demoting a numeric column, while a genuinely
  // mixed column stays categorical rather than silently losing values.
  if (numericShare >= 0.9 && numbers.length > 0) {
    const allIntegers = numbers.every((value) => Number.isInteger(value));
    if (allIntegers) {
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      if (distinct === 2 && min >= 0 && max <= 1) return 'binary';
      /*
       * The signature of a rating item: few distinct small integers, bounded —
       * *and repeated*. The repetition test is what separates a Likert scale
       * from an identifier: a 1–10 rating answered by ten people has values
       * that recur, while `id` 1…10 has ten distinct values in ten rows. Without
       * it every small dataset's ID column is mistaken for an opinion, and the
       * whole test-selection stage that follows inherits the error.
       */
      const repeats = present >= distinct * 2;
      if (distinct >= 2 && distinct <= 11 && min >= 0 && max <= 10 && repeats) return 'likert';
      return 'integer';
    }
    return 'numeric';
  }

  if (looksLikeDates(texts)) return 'date';
  if (distinct <= MAX_CATEGORIES && distinct < present) return 'categorical';
  return 'text';
}

function scaleFor(type: ColumnType, distinct: number): MeasurementScale {
  switch (type) {
    case 'numeric':
      return 'ratio';
    case 'integer':
      return 'ratio';
    case 'likert':
      return 'ordinal';
    case 'binary':
      return 'nominal';
    case 'categorical':
      return distinct <= 2 ? 'nominal' : 'nominal';
    case 'date':
      return 'interval';
    default:
      return 'unknown';
  }
}

const DATE_PATTERNS = [
  /^\d{4}-\d{1,2}-\d{1,2}$/,
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,
  /^\d{1,2}-\d{1,2}-\d{4}$/,
  /^\d{4}\/\d{1,2}\/\d{1,2}$/,
];

function looksLikeDates(texts: string[]): boolean {
  if (texts.length === 0) return false;
  const matching = texts.filter((text) => DATE_PATTERNS.some((pattern) => pattern.test(text)));
  return matching.length / texts.length >= 0.9;
}

function summarise(values: number[]): NumericSummary {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return {
    count: values.length,
    mean: mean(values),
    median: median(values),
    sd: standardDeviation(values),
    variance: variance(values),
    min: Math.min(...values),
    max: Math.max(...values),
    q1,
    q3,
    iqr: q3 - q1,
    skewness: skewness(values),
    kurtosis: kurtosis(values),
  };
}

/**
 * Tukey's fences, with a fallback.
 *
 * The 1.5×IQR rule is the standard and is robust, but it says nothing useful
 * when at least half the values are identical and the IQR collapses to zero.
 * In that case the z-score rule is used instead, and the report says which rule
 * produced the flag — an outlier is a claim, and a claim needs its method.
 */
function findOutliers(
  numbers: { value: number; row: number }[],
  summary: NumericSummary,
): { rows: number[]; rule: 'iqr-1.5' | 'z-3' } {
  if (numbers.length < 8) return { rows: [], rule: 'iqr-1.5' };

  if (summary.iqr > 0) {
    const low = summary.q1 - 1.5 * summary.iqr;
    const high = summary.q3 + 1.5 * summary.iqr;
    return {
      rows: numbers.filter((entry) => entry.value < low || entry.value > high).map((entry) => entry.row),
      rule: 'iqr-1.5',
    };
  }

  if (summary.sd === 0) return { rows: [], rule: 'z-3' };
  return {
    rows: numbers
      .filter((entry) => Math.abs((entry.value - summary.mean) / summary.sd) > 3)
      .map((entry) => entry.row),
    rule: 'z-3',
  };
}

function countCategories(texts: string[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  const total = texts.length || 1;
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, percent: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count);
}

/* -------------------------------------------------------------------------- */
/*                                   Issues                                   */
/* -------------------------------------------------------------------------- */

function findDuplicateRows(rows: CellValue[][]): number[] {
  const seen = new Map<string, number>();
  const duplicates: number[] = [];
  rows.forEach((row, index) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) duplicates.push(index);
    else seen.set(key, index);
  });
  return duplicates;
}

function collectIssues(
  dataset: Dataset,
  columns: ColumnProfile[],
  duplicateRows: number[],
): DataIssue[] {
  const issues: DataIssue[] = [];
  const rows = dataset.rows;

  if (rows.length < SMALL_SAMPLE) {
    issues.push({
      kind: 'small-sample',
      severity: 'warning',
      column: null,
      count: rows.length,
      sampleRows: [],
      detail: { threshold: SMALL_SAMPLE },
    });
  }

  if (duplicateRows.length > 0) {
    issues.push({
      kind: 'duplicate-rows',
      severity: 'warning',
      column: null,
      count: duplicateRows.length,
      sampleRows: duplicateRows.slice(0, SAMPLE_LIMIT),
    });
  }

  const duplicateColumns = findDuplicateColumns(dataset);
  for (const pair of duplicateColumns) {
    issues.push({
      kind: 'duplicate-columns',
      severity: 'info',
      column: pair.duplicate,
      count: rows.length,
      sampleRows: [],
      detail: { sameAs: pair.original },
    });
  }

  for (const column of columns) {
    if (column.type === 'empty') {
      issues.push({
        kind: 'empty-column',
        severity: 'warning',
        column: column.name,
        count: 0,
        sampleRows: [],
      });
      continue;
    }

    if (column.missing > 0) {
      issues.push({
        kind: 'missing-values',
        severity: column.missingPercent > 20 ? 'error' : column.missingPercent > 5 ? 'warning' : 'info',
        column: column.name,
        count: column.missing,
        sampleRows: missingRowsFor(rows, column.index).slice(0, SAMPLE_LIMIT),
        detail: { percent: Number(column.missingPercent.toFixed(2)) },
      });
    }

    if (column.constant) {
      issues.push({
        kind: 'constant-column',
        severity: 'warning',
        column: column.name,
        count: column.present,
        sampleRows: [],
      });
    }

    if (column.outlierRows.length > 0) {
      issues.push({
        kind: 'outliers',
        severity: 'info',
        column: column.name,
        count: column.outlierRows.length,
        sampleRows: column.outlierRows.slice(0, SAMPLE_LIMIT),
        detail: { rule: column.outlierRule },
      });
    }

    const whitespace = whitespaceRows(rows, column.index);
    if (whitespace.length > 0) {
      issues.push({
        kind: 'whitespace',
        severity: 'info',
        column: column.name,
        count: whitespace.length,
        sampleRows: whitespace.slice(0, SAMPLE_LIMIT),
      });
    }

    const inconsistent = inconsistentCategories(rows, column.index, column.type);
    if (inconsistent.length > 0) {
      issues.push({
        kind: 'inconsistent-categories',
        severity: 'warning',
        column: column.name,
        count: inconsistent.reduce((total, group) => total + group.variants.length, 0),
        sampleRows: [],
        detail: { groups: inconsistent.slice(0, 5) },
      });
    }

    const mixed = mixedTypeRows(rows, column.index, column.type);
    if (mixed.length > 0) {
      issues.push({
        kind: 'mixed-types',
        severity: 'warning',
        column: column.name,
        count: mixed.length,
        sampleRows: mixed.slice(0, SAMPLE_LIMIT),
      });
    }

    const implausible = implausibleRows(rows, column);
    if (implausible.rows.length > 0) {
      issues.push({
        kind: 'implausible-values',
        severity: 'warning',
        column: column.name,
        count: implausible.rows.length,
        sampleRows: implausible.rows.slice(0, SAMPLE_LIMIT),
        detail: { rule: implausible.rule },
      });
    }
  }

  const unnamed = columns.filter((column) => /^column_\d+$/.test(column.name));
  if (unnamed.length > 0) {
    issues.push({
      kind: 'unnamed-column',
      severity: 'info',
      column: null,
      count: unnamed.length,
      sampleRows: [],
      detail: { columns: unnamed.map((column) => column.name) },
    });
  }

  return issues;
}

function missingRowsFor(rows: CellValue[][], index: number): number[] {
  const result: number[] = [];
  rows.forEach((row, rowIndex) => {
    const value = row[index] ?? null;
    if (value === null || value === '') result.push(rowIndex);
  });
  return result;
}

function whitespaceRows(rows: CellValue[][], index: number): number[] {
  const result: number[] = [];
  rows.forEach((row, rowIndex) => {
    const value = row[index];
    if (typeof value === 'string' && value !== value.trim()) result.push(rowIndex);
  });
  return result;
}

/**
 * Categories that differ only by case, spacing or Arabic orthography.
 *
 * "طالب" and "طالب " are one group to a human and two groups to a chi-square
 * test, which is how a frequency table ends up with the same answer listed
 * twice. Alef and yaa variants are folded for the same reason.
 */
function inconsistentCategories(
  rows: CellValue[][],
  index: number,
  type: ColumnType,
): { canonical: string; variants: string[] }[] {
  if (type !== 'categorical' && type !== 'binary' && type !== 'text') return [];

  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    const value = row[index];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const key = normaliseLabel(value);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(value);
  }

  const result: { canonical: string; variants: string[] }[] = [];
  for (const [key, variants] of groups) {
    if (variants.size > 1) result.push({ canonical: key, variants: [...variants] });
  }
  return result;
}

export function normaliseLabel(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ْ]/g, '');
}

/** Values that do not parse as numbers in a column that is otherwise numeric. */
function mixedTypeRows(rows: CellValue[][], index: number, type: ColumnType): number[] {
  if (type !== 'numeric' && type !== 'integer' && type !== 'likert') return [];
  const result: number[] = [];
  rows.forEach((row, rowIndex) => {
    const value = row[index];
    if (value === null || value === '') return;
    if (toNumber(value) === null) result.push(rowIndex);
  });
  return result;
}

/**
 * Values that are not merely unusual but impossible.
 *
 * This is kept narrow on purpose. The tool cannot know a plausible range for
 * an arbitrary variable, and guessing would produce confident nonsense. It
 * flags only what the column name itself licenses — an age of 240, a percentage
 * of 130, a negative count — and stays silent otherwise.
 */
function implausibleRows(
  rows: CellValue[][],
  column: ColumnProfile,
): { rows: number[]; rule: string } {
  if (column.type !== 'numeric' && column.type !== 'integer') return { rows: [], rule: '' };

  const name = normaliseLabel(column.name);
  const isAge = /\bage\b|العمر|السن/.test(name);
  const isPercent = /percent|percentage|نسبه|النسبه|المئويه/.test(name);
  const isCount = /count|number|عدد|تكرار/.test(name);

  const check = (value: number): boolean => {
    if (isAge) return value < 0 || value > 130;
    if (isPercent) return value < 0 || value > 100;
    if (isCount) return value < 0 || !Number.isInteger(value);
    return false;
  };

  if (!isAge && !isPercent && !isCount) return { rows: [], rule: '' };

  const flagged: number[] = [];
  rows.forEach((row, rowIndex) => {
    const parsed = toNumber(row[column.index]);
    if (parsed !== null && check(parsed)) flagged.push(rowIndex);
  });

  return { rows: flagged, rule: isAge ? 'age-range' : isPercent ? 'percent-range' : 'non-negative-count' };
}

function findDuplicateColumns(dataset: Dataset): { original: string; duplicate: string }[] {
  const signatures = new Map<string, string>();
  const pairs: { original: string; duplicate: string }[] = [];

  dataset.columns.forEach((name, index) => {
    const signature = JSON.stringify(dataset.rows.map((row) => row[index] ?? null));
    const existing = signatures.get(signature);
    if (existing) pairs.push({ original: existing, duplicate: name });
    else signatures.set(signature, name);
  });

  return pairs;
}
