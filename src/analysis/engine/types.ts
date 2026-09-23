/**
 * The deterministic statistics engine (P1-C): shared vocabulary.
 *
 * Everything here is pure and serialisable. The engine takes a typed dataset
 * and a typed specification and returns a normalised result; it never reads a
 * file, a database, a clock or an unseeded random source. That is what makes a
 * run reproducible from (dataset version, specification, engine version).
 */

/* -------------------------------------------------------------------------- */
/*                                   Engine                                   */
/* -------------------------------------------------------------------------- */

/**
 * The engine that computes every number, and its version. The version changes
 * whenever an algorithm, a default or a formula changes, so a stored run can
 * always say which code produced it. Bump it with a note in the report.
 */
export const ENGINE = { id: 'academic-ai-ts-core', version: '1.0.0' } as const;

/* -------------------------------------------------------------------------- */
/*                                   Issues                                   */
/* -------------------------------------------------------------------------- */

/**
 * - INFO: worth knowing; changes nothing.
 * - WARNING: the result stands, but a reader must be told.
 * - ERROR: this analysis cannot be run as specified (fix the specification).
 * - BLOCKING: the data cannot support this analysis at all (fix the data).
 */
export type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKING';

export interface Issue {
  /** Stable machine code, e.g. `missing-values`, `near-zero-variance`. */
  code: string;
  severity: Severity;
  columns: string[];
  message: string;
  messageAr: string;
  details?: Record<string, string | number | boolean | null>;
}

export const blocks = (issues: Issue[]) => issues.some((issue) => issue.severity === 'ERROR' || issue.severity === 'BLOCKING');

/* -------------------------------------------------------------------------- */
/*                                  Dataset                                   */
/* -------------------------------------------------------------------------- */

/** How a column is to be treated. Declared (or confirmed) by the researcher, never silently changed. */
export type ColumnType = 'numeric' | 'ordinal' | 'nominal' | 'binary' | 'text' | 'date';

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  /** Declared bounds for a rating scale or a measured range; values outside are flagged. */
  scaleMin?: number | null;
  scaleMax?: number | null;
  /** Codes that mean "missing" in this column (e.g. 99, -9), applied before analysis. */
  missingCodes?: (string | number)[];
}

export type Cell = string | number | null;

/** A dataset version as the engine sees it: a declared schema and the cells. */
export interface EngineDataset {
  columns: ColumnSchema[];
  rows: Cell[][];
}

/* -------------------------------------------------------------------------- */
/*                                   Result                                   */
/* -------------------------------------------------------------------------- */

/**
 * One reported number with everything needed to cite it.
 *
 * `key` is stable within a run (`coef:x1`, `alpha:Trust`, `indirect:X>M>Y`), so
 * tables, figures, the Research Graph and manuscript tokens all refer to the
 * same number by the same name.
 */
export interface Estimate {
  key: string;
  label: string;
  /** Grouping for tables: `coefficient`, `model`, `descriptive`, `reliability`, `loading`, … */
  family: string;
  /** The variable, construct, term or pair the number is about. */
  term: string | null;
  /** What `estimate` is: `b`, `beta`, `r`, `alpha`, `mean`, `loading`, `indirect`, … */
  stat: string;
  estimate: number;
  se?: number | null;
  /** Test statistic and its name (`t`, `z`, `F`, `chi2`). */
  statistic?: number | null;
  statisticName?: string | null;
  df?: number | null;
  df2?: number | null;
  p?: number | null;
  ciLow?: number | null;
  ciHigh?: number | null;
  ciLevel?: number | null;
  /** How the interval was obtained: `t`, `normal`, `fisher-z`, `bootstrap-percentile`. */
  ciMethod?: string | null;
  n?: number | null;
}

export interface NormalisedResult {
  analysisType: string;
  /** The exact method, e.g. `ols`, `one-way-anova+tukey`, `paf+promax`. */
  method: string;
  engine: typeof ENGINE;
  /** Cases supplied, used, and excluded (with the rule that excluded them). */
  sample: { supplied: number; used: number; excluded: number; missingStrategy: 'listwise' | 'pairwise' };
  estimates: Estimate[];
  /** Assumption and diagnostic checks, structured. */
  assumptions: { key: string; status: 'met' | 'violated' | 'inconclusive' | 'not-testable' | 'info'; statistic?: number | null; p?: number | null; detail?: string }[];
  issues: Issue[];
  /** Resolved parameters actually used (defaults filled in), part of the reproducibility record. */
  parameters: Record<string, unknown>;
  /** Seed used by any randomised step; null when the method is not randomised. */
  seed: number | null;
  /** Method-specific structured output (matrices, per-case diagnostics summaries). */
  payload: Record<string, unknown>;
}

/**
 * Canonical JSON: object keys sorted, so the same result always serialises to
 * the same string and hashes the same. Non-finite numbers become strings
 * (`"NaN"`, `"Infinity"`), which JSON cannot carry and which must not become 0.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (typeof raw === 'number' && !Number.isFinite(raw)) return String(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.fromEntries(Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return raw;
  });
}
