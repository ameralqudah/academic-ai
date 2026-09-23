/**
 * Reading columns out of an engine dataset, with every exclusion counted.
 *
 * A cell becomes `NaN` (never 0) when it is blank, is one of the column's
 * declared missing codes, or is not a number in a numeric column. The three are
 * counted separately, because "missing" and "not a number" are different
 * problems with different fixes, and a reader must be able to tell them apart.
 */

import { toNumber } from '../stats-core';

import type { Cell, ColumnSchema, EngineDataset } from './types';

export interface NumericColumn {
  name: string;
  values: number[];
  /** Blank cells. */
  missing: number;
  /** Cells equal to a declared missing code. */
  coded: number;
  /** Non-empty cells that are not numbers. */
  invalid: number;
}

export function column(dataset: EngineDataset, name: string): { schema: ColumnSchema; index: number } | null {
  const index = dataset.columns.findIndex((entry) => entry.name === name);
  return index < 0 ? null : { schema: dataset.columns[index]!, index };
}

function isMissingCode(schema: ColumnSchema, cell: Cell): boolean {
  if (!schema.missingCodes?.length || cell === null) return false;
  return schema.missingCodes.some((code) => String(code).trim() === String(cell).trim());
}

export function numeric(dataset: EngineDataset, name: string): NumericColumn {
  const found = column(dataset, name);
  if (!found) throw new EngineInputError('unknown-column', [name]);
  const out: NumericColumn = { name, values: [], missing: 0, coded: 0, invalid: 0 };
  for (const row of dataset.rows) {
    const cell = row[found.index] ?? null;
    if (cell === null || (typeof cell === 'string' && cell.trim() === '')) {
      out.missing += 1;
      out.values.push(Number.NaN);
    } else if (isMissingCode(found.schema, cell)) {
      out.coded += 1;
      out.values.push(Number.NaN);
    } else {
      const parsed = typeof cell === 'number' ? (Number.isFinite(cell) ? cell : null) : toNumber(cell);
      if (parsed === null) {
        out.invalid += 1;
        out.values.push(Number.NaN);
      } else out.values.push(parsed);
    }
  }
  return out;
}

/** Category labels as text; blank and coded-missing cells become null. */
export function categorical(dataset: EngineDataset, name: string): { values: (string | null)[]; missing: number } {
  const found = column(dataset, name);
  if (!found) throw new EngineInputError('unknown-column', [name]);
  let missing = 0;
  const values = dataset.rows.map((row) => {
    const cell = row[found.index] ?? null;
    if (cell === null || (typeof cell === 'string' && cell.trim() === '') || isMissingCode(found.schema, cell)) {
      missing += 1;
      return null;
    }
    return String(cell).trim();
  });
  return { values, missing };
}

/** Rows where every listed column is finite: the listwise sample. */
export function completeRows(columns: number[][]): number[] {
  const length = columns[0]?.length ?? 0;
  const rows: number[] = [];
  for (let row = 0; row < length; row += 1) {
    if (columns.every((values) => Number.isFinite(values[row]))) rows.push(row);
  }
  return rows;
}

export const pick = (values: number[], rows: number[]) => rows.map((row) => values[row] as number);

/** A specification that names a column the dataset does not have, or uses it in a way its type forbids. */
export class EngineInputError extends Error {
  constructor(
    readonly code: string,
    readonly columns: string[],
    readonly details: Record<string, string | number> = {},
  ) {
    super(`${code}: ${columns.join(', ')}`);
    this.name = 'EngineInputError';
  }
}
