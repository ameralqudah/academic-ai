/**
 * The vocabulary of the data layer.
 *
 * One rule governs every type here: a dataset is immutable. Cleaning does not
 * edit a dataset, it derives a new one and returns a report of what changed.
 * Nothing in this module can overwrite what the researcher uploaded, which is
 * the difference between a tool that assists analysis and a tool that quietly
 * destroys evidence.
 */

/** What a column holds, decided from the values rather than declared by the user. */
export type ColumnType =
  | 'numeric'
  | 'integer'
  | 'categorical'
  | 'binary'
  | 'likert'
  | 'date'
  | 'text'
  | 'empty';

/**
 * The measurement scale, which is what actually decides the statistics.
 *
 * A five-point Likert item is stored as an integer and is not an interval
 * quantity; treating it as one is the most common statistical error in student
 * research. It is recorded separately from the storage type for that reason.
 */
export type MeasurementScale = 'nominal' | 'ordinal' | 'interval' | 'ratio' | 'unknown';

export type CellValue = string | number | boolean | null;

export interface Dataset {
  /** Column names in their original order, trimmed and de-duplicated. */
  columns: string[];
  /** Row-major values. Every row has one entry per column, `null` when missing. */
  rows: CellValue[][];
  /** Where this came from: a file name, or a description of a derivation. */
  source: string;
  /** Rows dropped by the reader before profiling (blank lines, trailing junk). */
  skippedRows: number;
  /** Set when the file was larger than the row cap and had to be truncated. */
  truncatedTo?: number;
}

export interface NumericSummary {
  count: number;
  mean: number;
  median: number;
  sd: number;
  variance: number;
  min: number;
  max: number;
  q1: number;
  q3: number;
  iqr: number;
  skewness: number;
  kurtosis: number;
}

export interface CategoryCount {
  value: string;
  count: number;
  percent: number;
}

export interface ColumnProfile {
  name: string;
  index: number;
  type: ColumnType;
  scale: MeasurementScale;
  /** Non-missing values. */
  present: number;
  missing: number;
  missingPercent: number;
  distinct: number;
  /** Present for numeric-like columns only. */
  numeric?: NumericSummary;
  /** The most frequent values; capped, with `otherCount` holding the tail. */
  categories?: CategoryCount[];
  otherCount?: number;
  /** Row indices whose value lies outside the fences, by the stated rule. */
  outlierRows: number[];
  outlierRule?: 'iqr-1.5' | 'z-3';
  /** True when every present value is identical — no variance, no analysis. */
  constant: boolean;
}

export type IssueKind =
  | 'missing-values'
  | 'duplicate-rows'
  | 'duplicate-columns'
  | 'constant-column'
  | 'empty-column'
  | 'outliers'
  | 'implausible-values'
  | 'mixed-types'
  | 'whitespace'
  | 'inconsistent-categories'
  | 'small-sample'
  | 'unnamed-column';

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface DataIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  /** Column this concerns, or null when it is about the table as a whole. */
  column: string | null;
  /** How many rows or values are affected. */
  count: number;
  /** A few affected row indices, for the user to look at. Never the whole list. */
  sampleRows: number[];
  /** Machine-readable detail for the UI and for the cleaning planner. */
  detail?: Record<string, unknown>;
}

export interface DatasetProfile {
  source: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
  issues: DataIssue[];
  /** Rows that are exact duplicates of an earlier row. */
  duplicateRows: number[];
  /** Cells with no value, over the whole table. */
  missingCells: number;
  completeness: number;
  profiledAt: string;
}

/* -------------------------------------------------------------------------- */
/*                                  Cleaning                                  */
/* -------------------------------------------------------------------------- */

export type CleaningActionKind =
  | 'trim-whitespace'
  | 'normalise-categories'
  | 'drop-duplicate-rows'
  | 'drop-empty-columns'
  | 'drop-constant-columns'
  | 'drop-rows-missing'
  | 'impute-mean'
  | 'impute-median'
  | 'impute-mode'
  | 'flag-outliers'
  | 'remove-outliers'
  | 'coerce-numeric';

export interface CleaningAction {
  kind: CleaningActionKind;
  /** Columns this applies to. Empty means the whole table. */
  columns: string[];
  /** Why this is being proposed, in the researcher's language. */
  reasonKey: string;
  reasonParams?: Record<string, string | number>;
  /** Proposals start unselected when the choice is consequential. */
  recommended: boolean;
  /** True when the action removes rows or columns rather than editing values. */
  destructive: boolean;
}

export interface CleaningChange {
  action: CleaningActionKind;
  column: string | null;
  /** Rows or cells affected. */
  affected: number;
  before?: string;
  after?: string;
  rows?: number[];
}

export interface CleaningReport {
  /** The dataset the cleaning started from — always kept, never overwritten. */
  originalRows: number;
  originalColumns: number;
  cleanedRows: number;
  cleanedColumns: number;
  rowsRemoved: number;
  columnsRemoved: number;
  cellsChanged: number;
  changes: CleaningChange[];
  /** Actions the user selected but which had nothing to do. */
  noOps: CleaningActionKind[];
  cleanedAt: string;
}

export interface CleaningResult {
  cleaned: Dataset;
  report: CleaningReport;
}
