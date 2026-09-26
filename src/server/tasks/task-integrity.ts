/**
 * Numbers in task writing and task exports (WS2 B4, N4).
 *
 * A task's writing step and its file exports read the analyses earlier steps
 * produced. This is the one place that decides which of those results a
 * number may come from, with the same rules as section writing (WS2 A4) and
 * chat (WS2 A5):
 *
 * - results are tiered by what they recorded, never "verified" (only P1-C
 *   runs are): an analysis run by its row, PLS and CB-SEM by the provenance
 *   stored with them (WS2 N10), descriptive tables by the provenance of the
 *   data they read; a result with nothing recorded is unpinned (A5);
 * - a windowed result (the first rows of a file only) contributes nothing: no
 *   allowed number, no line in the writing prompt, no cell in an export (D3);
 * - only the researcher's own words (the request and their answers) are
 *   theirs. The planner's step input and earlier generated prose are not: a
 *   number a model wrote before is not made legitimate by being repeated.
 *
 * Exports are built from these results alone. The planner's `input.table` is
 * never a source: a table a language model wrote in a step input is not a
 * computed result (WS2 D5).
 *
 * Known limitations (recorded, not fixed here):
 * - Only `document.write` is guarded. Literature reviews, general and
 *   web-search answers, deep research and survey text are not: their numbers
 *   are mostly other studies' findings cited by source, and quarantining them
 *   would break a review. They reach DOCX/PDF/Markdown exports unchecked.
 * - Deletion protection (WS2 B3) reads `section_versions.integrity` only. A
 *   run cited in task prose (`prose.v1.integrity.sources`) does not block
 *   deleting that run or its dataset; task outputs are not manuscripts.
 * - XLSX and CSV hold computed analysis results only. A non-analysis table
 *   (a questionnaire, a list) can no longer be exported through a task in
 *   those formats; the planner's table was the only way it arrived.
 */

import {
  allowedFromLegacyResults,
  checkNumbers,
  legacyResultTier,
  quarantine,
  type LegacyAllowedValues,
  type LegacyResultLike,
  type LegacyResultTier,
  type NumberCheck,
} from '@/server/integrity/numbers';
import { sectionIntegrity, type SectionIntegrity } from '@/server/integrity/section';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import { asLegacyResult, readProvenance } from '@/server/stats/legacy-provenance';
import type { OutputReference } from './contracts';

type Row = Record<string, unknown>;

export type TaskResultKind = 'pls' | 'cbsem' | 'analysis' | 'reliability' | 'descriptives' | 'profile';

/** One computed result a task step produced, with what it recorded. */
export interface TaskResult {
  /** "S1", "S2"… in the order the outputs were produced: the key exports use. */
  source: string;
  kind: TaskResultKind;
  outputId: string;
  capability: string;
  /** The analysis run behind it, when there is one. */
  runId?: string;
  /** The test, for an analysis run. */
  test?: string;
  tier: LegacyResultTier;
  engineVersion: string | null;
  datasetVersionId: string | null;
  datasetContentHash: string | null;
  rowsAnalysed?: number;
  /** The row window, when only the first rows of a file were read. */
  truncatedTo?: number;
  /** The result's numbers. */
  result: unknown;
}

export interface TaskResults {
  /** Every result found, in production order, windowed ones included. */
  results: TaskResult[];
  /** The ones a text or an export may use: windowed ones left out. */
  eligible: TaskResult[];
  /** The numbers a text may repeat, by class, with the tiers used and excluded. */
  allowed: LegacyAllowedValues;
  /** Analysis outputs left out of the writing prompt (windowed). */
  excludedOutputs: ReadonlySet<string>;
}

const RESULT_TYPES = new Set(['pls-results.v1', 'analysis.v1']);

function asRow(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

/**
 * The computed results among a step's available outputs, tiered.
 *
 * Reads `pls-results.v1` and `analysis.v1` only. Displays that report no
 * result (a note, a recommendation, figures, cleaning proposals) contribute
 * no numbers, but one computed on a windowed file is still left out of the
 * prompt.
 */
export async function collectTaskResults(available: readonly OutputReference[], userId: string): Promise<TaskResults> {
  const results: TaskResult[] = [];
  const excludedOutputs = new Set<string>();

  for (const output of available) {
    if (!RESULT_TYPES.has(output.type)) continue;
    const data = asRow(output.data);
    const found = await resolve(output, data, userId);
    if (!found) continue;
    if (found.tier === 'windowed') excludedOutputs.add(output.id);
    if (found.kind) results.push({ ...found, kind: found.kind, source: `S${results.length + 1}` });
  }

  const eligible = results.filter((result) => result.tier !== 'windowed');
  const allowed = allowedFromLegacyResults(
    results.map((result) => ({ ...legacyOf(result), id: result.runId ?? result.outputId })),
  );

  return { results, eligible, allowed, excludedOutputs };
}

/** The shape `allowedFromLegacyResults` reads. */
function legacyOf(result: TaskResult): LegacyResultLike {
  return {
    result: result.result,
    spec: result.truncatedTo ? { truncatedTo: result.truncatedTo } : {},
    datasetVersionId: result.datasetVersionId,
    datasetContentHash: result.datasetContentHash,
    engineVersion: result.engineVersion,
  };
}

type Resolved = Omit<TaskResult, 'source' | 'kind'> & { kind: TaskResultKind | null };

async function resolve(output: OutputReference, data: Row, userId: string): Promise<Resolved | null> {
  const base = { outputId: output.id, capability: output.producedBy.capability };

  /* A result stored with its provenance (WS2 N10), or unpinned without one (A5). */
  const fromProvenance = (kind: TaskResultKind | null, result: unknown, provenance: unknown): Resolved => {
    const recorded = readProvenance(provenance);
    const legacy: LegacyResultLike = recorded ? asLegacyResult(result, recorded) : { result };
    return {
      ...base,
      kind,
      tier: legacyResultTier(legacy),
      engineVersion: legacy.engineVersion ?? null,
      datasetVersionId: legacy.datasetVersionId ?? null,
      datasetContentHash: legacy.datasetContentHash ?? null,
      ...(recorded ? { rowsAnalysed: recorded.rowsAnalysed } : {}),
      ...(recorded?.truncatedTo ? { truncatedTo: recorded.truncatedTo } : {}),
      result,
    };
  };

  if (output.type === 'pls-results.v1') {
    return fromProvenance('pls', { estimates: data.estimates, n: data.n }, data.provenance);
  }

  /* CB-SEM from `statistics.cbsem`. */
  if (data.method === 'cb-sem') {
    return fromProvenance('cbsem', { fit: data.fit, loadings: data.loadings, n: data.n }, data.provenance);
  }

  /* A `data.analyse` display. */
  const display = asRow(data.display);
  const kind = typeof display.kind === 'string' ? display.kind : null;
  if (!kind) return null;
  const payload = display.payload;

  if ((kind === 'analysis' || kind === 'reliability') && typeof display.runId === 'string') {
    /* Tiered by its run row; a run no longer found keeps the display's numbers, unpinned (A5). */
    const run = await analysisRunsRepo.findOwned(display.runId, userId);
    if (run) {
      const spec = asRow(run.spec);
      return {
        ...base,
        kind,
        runId: run.id,
        test: run.testKey,
        tier: legacyResultTier(run),
        engineVersion: run.engineVersion ?? null,
        datasetVersionId: run.datasetVersionId ?? null,
        datasetContentHash: run.datasetContentHash ?? null,
        ...(typeof spec.truncatedTo === 'number' && spec.truncatedTo > 0 ? { truncatedTo: spec.truncatedTo } : {}),
        result: run.result,
      };
    }
    return { ...fromProvenance(kind, payload, undefined), runId: display.runId };
  }

  if (kind === 'pls' || kind === 'cbsem') return fromProvenance(kind, payload, asRow(payload).provenance);

  /* Tables read from the file itself: the provenance of the data read (WS2 B4). */
  if (kind === 'descriptives' || kind === 'profile') return fromProvenance(kind, payload, data.provenance);

  /* No result of its own; tiered only to keep a windowed one out of the prompt. */
  return fromProvenance(null, null, data.provenance);
}

/* -------------------------------------------------------------------------- */
/*                                   Writing                                  */
/* -------------------------------------------------------------------------- */

/** The researcher's own words in a task: the request and their answers. Never the planner's step input. */
export function researcherText(context: Record<string, unknown>): string[] {
  const request = typeof context.request === 'string' ? context.request : '';
  const answers = Array.isArray(context.userAnswers) ? context.userAnswers.filter((answer): answer is string => typeof answer === 'string') : [];
  return [request, ...answers].map((text) => text.trim()).filter(Boolean);
}

/**
 * Model prose with every untraced research number quarantined (WS2 A4 rules):
 * kept only when it traces to an eligible result within its class, or was
 * written in the researcher's own words. The record is stored with the prose.
 */
export function guardTaskProse(
  text: string,
  input: { allowed: LegacyAllowedValues; stated: readonly string[]; language: 'ar' | 'en' },
): { text: string; quarantined: number; check: NumberCheck; integrity: SectionIntegrity } {
  const check = checkNumbers(text, {
    mode: 'model',
    allowed: input.allowed.values,
    ...(input.stated.length ? { context: input.stated } : {}),
  });
  const guarded = quarantine(text, check, input.language);
  return {
    text: guarded.text,
    quarantined: guarded.quarantined,
    check,
    integrity: sectionIntegrity({ mode: 'model', check, legacy: input.allowed, quarantined: guarded.quarantined }),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Exports                                  */
/* -------------------------------------------------------------------------- */

export type Cell = string | number | null;

export interface ExportTable {
  source: string;
  name: string;
  headers: string[];
  rows: Cell[][];
}

const num = (value: unknown): Cell => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(asRow) : []);

/** PLS estimates, from a task output (`estimates`) or a full analysis (a `data.analyse` display). */
function plsTables(source: string, result: Row): ExportTable[] {
  const estimates = asRow(result.estimates);
  const structural = asRow(result.structural);
  const paths = estimates.paths ? list(estimates.paths) : list(structural.paths);
  const rSquared = estimates.rSquared ? list(estimates.rSquared) : list(structural.endogenous);
  const loadings = estimates.loadings ? list(estimates.loadings) : list(result.measurement).flatMap((construct) => list(construct.indicators));
  const tables: ExportTable[] = [];
  if (paths.length) tables.push({ source, name: 'PLS path coefficients', headers: ['From', 'To', 'Coefficient'], rows: paths.map((path) => [text(path.from), text(path.to), num(path.coefficient)]) });
  if (rSquared.length) tables.push({ source, name: 'PLS R squared', headers: ['Construct', 'R squared'], rows: rSquared.map((entry) => [text(entry.construct), num(entry.rSquared)]) });
  if (loadings.length) tables.push({ source, name: 'PLS loadings', headers: ['Construct', 'Indicator', 'Loading'], rows: loadings.map((entry) => [text(entry.construct), text(entry.indicator), num(entry.loading)]) });
  return tables;
}

const FIT_INDICES: [string, string][] = [
  ['chiSquare', 'Chi-square'],
  ['df', 'df'],
  ['pValue', 'p'],
  ['normedChiSquare', 'Chi-square/df'],
  ['cfi', 'CFI'],
  ['tli', 'TLI'],
  ['rmsea', 'RMSEA'],
  ['srmr', 'SRMR'],
];

function cbsemTables(source: string, result: Row): ExportTable[] {
  const fit = asRow(result.fit);
  const fitRows = FIT_INDICES.filter(([key]) => num(fit[key]) !== null).map(([key, label]): Cell[] => [label, num(fit[key])]);
  const loadings = list(result.loadings);
  const tables: ExportTable[] = [];
  if (fitRows.length) tables.push({ source, name: 'CB-SEM fit indices', headers: ['Index', 'Value'], rows: fitRows });
  if (loadings.length) tables.push({ source, name: 'CB-SEM standardised loadings', headers: ['Construct', 'Indicator', 'Standardised loading'], rows: loadings.map((entry) => [text(entry.construct), text(entry.indicator), num(entry.standardised)]) });
  return tables;
}

function analysisTables(source: string, result: Row, test: string | undefined): ExportTable[] {
  const statistic = asRow(result.statistic);
  const effect = asRow(result.effect);
  const df = Array.isArray(result.df) ? result.df.map((value) => text(value)).join(', ') : num(result.df);
  const tables: ExportTable[] = [
    {
      source,
      name: 'Test result',
      headers: ['Test', 'Statistic', 'Value', 'df', 'p', 'Effect size', 'Effect value', 'N'],
      rows: [[text(test ?? result.test), text(statistic.name), num(statistic.value), df, num(result.pValue), text(effect.name), num(effect.value), num(result.n)]],
    },
  ];
  const groups = list(result.estimates).filter((estimate) => estimate.label !== undefined);
  if (groups.length) tables.push({ source, name: 'Group estimates', headers: ['Group', 'N', 'Mean', 'SD'], rows: groups.map((group) => [text(group.label), num(group.n), num(group.mean), num(group.sd)]) });
  return tables;
}

function reliabilityTables(source: string, result: Row): ExportTable[] {
  const items = Array.isArray(result.items) ? result.items.length : num(result.itemCount);
  return [{ source, name: 'Reliability', headers: ['Alpha', 'Items', 'N'], rows: [[num(result.alpha), items, num(result.n)]] }];
}

function descriptiveTables(source: string, result: Row): ExportTable[] {
  const rows = list(result.descriptives);
  const tables: ExportTable[] = [];
  if (rows.length) {
    tables.push({
      source,
      name: 'Descriptive statistics',
      headers: ['Variable', 'N', 'Minimum', 'Maximum', 'Mean', 'SD'],
      rows: rows.map((row) => [text(row.variable), num(row.n), num(row.min), num(row.max), num(row.mean), num(row.sd)]),
    });
  }
  for (const table of list(result.frequencies)) {
    tables.push({
      source,
      name: `Frequencies: ${text(table.variable)}`,
      headers: ['Value', 'Frequency', 'Percent', 'Valid percent', 'Cumulative percent'],
      rows: list(table.rows).map((row) => [text(row.value), num(row.frequency), num(row.percent), num(row.validPercent), num(row.cumulativePercent)]),
    });
  }
  return tables;
}

/** The tables of the given results, in order, with their numbers as numbers. A profile has none of its own. */
export function exportTables(results: readonly TaskResult[]): ExportTable[] {
  return results.flatMap((entry) => {
    const result = asRow(entry.result);
    switch (entry.kind) {
      case 'pls':
        return plsTables(entry.source, result);
      case 'cbsem':
        return cbsemTables(entry.source, result);
      case 'analysis':
        return analysisTables(entry.source, result, entry.test);
      case 'reliability':
        return reliabilityTables(entry.source, result);
      case 'descriptives':
        return descriptiveTables(entry.source, result);
      default:
        return [];
    }
  });
}

/** How every exported result is described: computed, never "verified". */
export const EXPORT_STATUS = 'Computed by the legacy analysis engine; not independently verified';

export const PROVENANCE_HEADERS = ['Source', 'Analysis', 'Step', 'Reference', 'Tier', 'Engine', 'Dataset version', 'Content hash', 'Rows analysed', 'Status'];

/** One row per exported result: where its numbers came from. */
export function provenanceRows(results: readonly TaskResult[]): Cell[][] {
  return results.map((entry) => [
    entry.source,
    entry.test ? `${entry.kind}: ${entry.test}` : entry.kind,
    entry.capability,
    entry.runId ? `run:${entry.runId}` : `output:${entry.outputId}`,
    entry.tier,
    entry.engineVersion ?? '',
    entry.datasetVersionId ?? '',
    entry.datasetContentHash ?? '',
    entry.rowsAnalysed ?? null,
    EXPORT_STATUS,
  ]);
}

export const LONG_HEADERS = ['source', 'table', 'row', 'column', 'value'];

/**
 * Every table as one long table (source | table | row | column | value), then
 * the provenance of each source under the table name "provenance". Rows are
 * numbered from 1 within their table; empty cells are kept as empty values.
 */
export function longRows(tables: readonly ExportTable[], results: readonly TaskResult[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const table of tables) {
    table.rows.forEach((row, index) => {
      table.headers.forEach((header, column) => rows.push([table.source, table.name, index + 1, header, row[column] ?? null]));
    });
  }
  for (const row of provenanceRows(results)) {
    PROVENANCE_HEADERS.slice(1).forEach((header, column) => rows.push([row[0] as string, 'provenance', 1, header, row[column + 1] ?? null]));
  }
  return rows;
}
