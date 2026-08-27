import type { CellValue, Dataset } from './types';

/**
 * Readers for the two formats researchers actually arrive with.
 *
 * Both produce the same `Dataset`, so nothing downstream knows or cares which
 * one was uploaded. Neither reader interprets anything: it returns strings,
 * numbers and nulls exactly as they were written. Deciding what a value *means*
 * belongs to the profiler, where the decision can be inspected and overridden.
 */

/** Beyond this the browser, the database and the reader all start to suffer. */
export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 300;

export class DataParseError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'DataParseError';
  }
}

/* -------------------------------------------------------------------------- */
/*                                    CSV                                     */
/* -------------------------------------------------------------------------- */

/**
 * Picks the delimiter by looking at the file instead of assuming a comma.
 *
 * Excel writes CSV using the list separator of the machine's locale, so an
 * Arabic or European Windows exports semicolons. Guessing wrong turns the whole
 * table into a single column, which users reasonably report as "it's broken".
 * The winner is the candidate that yields the most consistent field count.
 */
export function detectDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|'];
  const lines = sample.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const delimiter of candidates) {
    const counts = lines.map((line) => splitCsvLine(line, delimiter).length);
    const first = counts[0] ?? 0;
    if (first < 2) continue;
    const consistent = counts.filter((count) => count === first).length / counts.length;
    // Field count breaks ties: two delimiters can both be consistent, and the
    // one that actually divides the row is the one producing more fields.
    const score = consistent * 100 + Math.min(first, 50);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/** One line, respecting quotes. Used only by delimiter detection. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

/**
 * A full CSV reader: quoted fields, escaped quotes, newlines inside fields,
 * CRLF, and a leading byte-order mark.
 */
export function parseCsv(text: string, source: string, delimiter?: string): Dataset {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = delimiter ?? detectDelimiter(content.slice(0, 64_000));

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;
  let sawAnyChar = false;

  const endField = () => {
    record.push(field);
    field = '';
    fieldWasQuoted = false;
  };

  const endRecord = () => {
    endField();
    // A trailing newline produces one empty field; that is not a row.
    const isBlank = record.length === 1 && (record[0] ?? '').trim() === '';
    if (!isBlank) records.push(record);
    record = [];
  };

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    sawAnyChar = true;

    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      fieldWasQuoted = true;
      continue;
    }

    if (char === sep) {
      endField();
      continue;
    }

    if (char === '\r') {
      if (content[i + 1] === '\n') i += 1;
      endRecord();
      continue;
    }

    if (char === '\n') {
      endRecord();
      continue;
    }

    field += char;
  }

  if (sawAnyChar && (field.length > 0 || record.length > 0 || fieldWasQuoted)) endRecord();

  if (records.length === 0) throw new DataParseError('analysis.error.emptyFile');

  return fromRecords(records, source);
}

/* -------------------------------------------------------------------------- */
/*                             Records -> Dataset                             */
/* -------------------------------------------------------------------------- */

/** Turns a plain grid of strings into a dataset with a header row. */
export function fromRecords(records: string[][], source: string): Dataset {
  const rawHeader = records[0] ?? [];
  if (rawHeader.length === 0) throw new DataParseError('analysis.error.noColumns');
  if (rawHeader.length > MAX_COLUMNS) {
    throw new DataParseError('analysis.error.tooManyColumns', {
      limit: MAX_COLUMNS,
      found: rawHeader.length,
    });
  }

  const columns = uniqueNames(rawHeader.map((name, index) => cleanHeader(name, index)));

  const body = records.slice(1);
  const truncated = body.length > MAX_ROWS;
  const usable = truncated ? body.slice(0, MAX_ROWS) : body;

  let skipped = 0;
  const rows: CellValue[][] = [];

  for (const record of usable) {
    // A row of nothing but separators is an artefact of the file, not data.
    if (record.every((value) => value.trim() === '')) {
      skipped += 1;
      continue;
    }
    const row: CellValue[] = new Array(columns.length).fill(null);
    for (let c = 0; c < columns.length; c += 1) {
      row[c] = normaliseCell(record[c]);
    }
    rows.push(row);
  }

  if (rows.length === 0) throw new DataParseError('analysis.error.noRows');

  return {
    columns,
    rows,
    source,
    skippedRows: skipped,
    ...(truncated ? { truncatedTo: MAX_ROWS } : {}),
  };
}

function cleanHeader(name: string | undefined, index: number): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : `column_${index + 1}`;
}

/** Excel exports repeat header names cheerfully; downstream code cannot. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

/**
 * The only normalisation applied at read time.
 *
 * Empty, whitespace-only and the conventional missing markers become `null`.
 * Everything else is kept **verbatim**, stray spaces included. Trimming here
 * would be silent editing: the promise this module makes is that the dataset in
 * memory is the file the researcher uploaded, and that every difference between
 * that and the cleaned copy appears in the cleaning report. Whitespace is not
 * important enough to break that promise for.
 */
const MISSING_MARKERS = new Set([
  '',
  'na',
  'n/a',
  'n.a.',
  'null',
  'nil',
  'none',
  '-',
  '--',
  '#n/a',
  '#null!',
  '#div/0!',
  '.',
  'لا يوجد',
  'غير متوفر',
  'لا ينطبق',
]);

export function normaliseCell(value: string | undefined | null): CellValue {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (MISSING_MARKERS.has(trimmed.toLowerCase())) return null;
  return value;
}
