/**
 * The descriptive tables a statistics package prints first.
 *
 * "Describe my data" showed each column's name, type and missing count — a
 * file inspector's view. A researcher asking for SPSS output expects the two
 * tables every methods chapter reports: Descriptive Statistics for the
 * numbers, and a Frequencies table for each category variable.
 *
 * Nothing here is estimated. Every figure is read from the profile, which the
 * engine computed from the file; this only arranges it.
 */

import type { ColumnProfile, DatasetProfile } from './types';

export interface DescriptiveRow {
  variable: string;
  n: number;
  missing: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
  skewness: number;
  kurtosis: number;
}

export interface FrequencyRow {
  value: string;
  frequency: number;
  /** Of every row, missing included. */
  percent: number;
  /** Of the rows that answered. */
  validPercent: number;
  cumulativePercent: number;
}

export interface FrequencyTable {
  variable: string;
  rows: FrequencyRow[];
  missing: number;
  total: number;
}

export interface DescriptiveTables {
  n: number;
  descriptives: DescriptiveRow[];
  frequencies: FrequencyTable[];
  /** Columns left out, and why: an identifier is not a variable. */
  skipped: { variable: string; reason: 'identifier' | 'text' | 'empty' | 'constant' }[];
}

/** A column whose every value differs — a participant code, an email. */
function isIdentifier(column: ColumnProfile): boolean {
  return column.present > 1 && column.distinct === column.present && column.type !== 'numeric';
}

function frequencyTable(column: ColumnProfile, rows: number): FrequencyTable {
  const total = column.present + column.missing || rows;
  const entries = [...(column.categories ?? [])];
  if (column.otherCount) entries.push({ value: '…', count: column.otherCount, percent: 0 });

  /* A scale reads in its own order, 1 to 5; a category by how often it occurs. */
  const numericOrder = entries.every((entry) => entry.value === '…' || Number.isFinite(Number(entry.value)));
  if (numericOrder) entries.sort((a, b) => (a.value === '…' ? 1 : b.value === '…' ? -1 : Number(a.value) - Number(b.value)));

  let cumulative = 0;
  return {
    variable: column.name,
    missing: column.missing,
    total,
    rows: entries.map((entry) => {
      const validPercent = column.present ? (entry.count / column.present) * 100 : 0;
      cumulative += validPercent;
      return {
        value: entry.value,
        frequency: entry.count,
        percent: total ? (entry.count / total) * 100 : 0,
        validPercent,
        cumulativePercent: Math.min(100, cumulative),
      };
    }),
  };
}

export function descriptiveTables(profile: DatasetProfile): DescriptiveTables {
  const descriptives: DescriptiveRow[] = [];
  const frequencies: FrequencyTable[] = [];
  const skipped: DescriptiveTables['skipped'] = [];

  for (const column of profile.columns) {
    if (column.present === 0) {
      skipped.push({ variable: column.name, reason: 'empty' });
      continue;
    }
    if (isIdentifier(column)) {
      skipped.push({ variable: column.name, reason: 'identifier' });
      continue;
    }

    if (column.numeric) {
      descriptives.push({
        variable: column.name,
        n: column.numeric.count,
        missing: column.missing,
        min: column.numeric.min,
        max: column.numeric.max,
        mean: column.numeric.mean,
        sd: column.numeric.sd,
        skewness: column.numeric.skewness,
        kurtosis: column.numeric.kurtosis,
      });
    }

    /* Categories, and the points of a scale: both are counted. */
    const counted = column.type === 'categorical' || column.type === 'binary' || column.type === 'likert';
    if (counted && column.categories?.length) {
      frequencies.push(frequencyTable(column, profile.rowCount));
    } else if (!column.numeric) {
      skipped.push({ variable: column.name, reason: column.constant ? 'constant' : 'text' });
    }
  }

  return { n: profile.rowCount, descriptives, frequencies, skipped };
}
