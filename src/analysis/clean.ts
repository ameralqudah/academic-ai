import { normaliseLabel } from './profile';
import { mean, median, mode, toNumber } from './stats-core';
import type {
  CellValue,
  CleaningAction,
  CleaningChange,
  CleaningReport,
  CleaningResult,
  Dataset,
  DatasetProfile,
} from './types';

/**
 * Cleaning, in two halves that are deliberately kept apart.
 *
 * `planCleaning` proposes. `applyCleaning` executes, and only what it was
 * given. Nothing is applied because it was suggested: the researcher decides,
 * because every one of these choices changes what the results will say, and a
 * tool that silently drops a third of the rows has fabricated a finding as
 * surely as one that invents a p-value.
 *
 * The original dataset is never modified. `applyCleaning` builds a new one and
 * returns a report of every change, which is what makes the cleaning
 * reproducible and defensible in a methodology chapter.
 */

const IMPUTE_CEILING_PERCENT = 20;

export function planCleaning(dataset: DatasetProfile): CleaningAction[] {
  const actions: CleaningAction[] = [];
  const byName = new Map(dataset.columns.map((column) => [column.name, column]));

  const whitespaceColumns = dataset.issues
    .filter((issue) => issue.kind === 'whitespace' && issue.column)
    .map((issue) => issue.column as string);

  if (whitespaceColumns.length > 0) {
    actions.push({
      kind: 'trim-whitespace',
      columns: whitespaceColumns,
      reasonKey: 'analysis.clean.reason.whitespace',
      reasonParams: { columns: whitespaceColumns.length },
      recommended: true,
      destructive: false,
    });
  }

  const inconsistentColumns = dataset.issues
    .filter((issue) => issue.kind === 'inconsistent-categories' && issue.column)
    .map((issue) => issue.column as string);

  if (inconsistentColumns.length > 0) {
    actions.push({
      kind: 'normalise-categories',
      columns: inconsistentColumns,
      reasonKey: 'analysis.clean.reason.inconsistentCategories',
      reasonParams: { columns: inconsistentColumns.length },
      recommended: true,
      destructive: false,
    });
  }

  if (dataset.duplicateRows.length > 0) {
    actions.push({
      kind: 'drop-duplicate-rows',
      columns: [],
      reasonKey: 'analysis.clean.reason.duplicateRows',
      reasonParams: { rows: dataset.duplicateRows.length },
      // Recommended, but still a choice: repeated measurements can look like
      // duplicates when an identifier column is missing from the export.
      recommended: true,
      destructive: true,
    });
  }

  const emptyColumns = dataset.columns.filter((column) => column.type === 'empty');
  if (emptyColumns.length > 0) {
    actions.push({
      kind: 'drop-empty-columns',
      columns: emptyColumns.map((column) => column.name),
      reasonKey: 'analysis.clean.reason.emptyColumns',
      reasonParams: { columns: emptyColumns.length },
      recommended: true,
      destructive: true,
    });
  }

  const constantColumns = dataset.columns.filter((column) => column.constant);
  if (constantColumns.length > 0) {
    actions.push({
      kind: 'drop-constant-columns',
      columns: constantColumns.map((column) => column.name),
      reasonKey: 'analysis.clean.reason.constantColumns',
      reasonParams: { columns: constantColumns.length },
      recommended: false,
      destructive: true,
    });
  }

  const mixedColumns = dataset.issues
    .filter((issue) => issue.kind === 'mixed-types' && issue.column)
    .map((issue) => issue.column as string);

  if (mixedColumns.length > 0) {
    actions.push({
      kind: 'coerce-numeric',
      columns: mixedColumns,
      reasonKey: 'analysis.clean.reason.mixedTypes',
      reasonParams: { columns: mixedColumns.length },
      recommended: false,
      destructive: true,
    });
  }

  /* ------------------------------- missing ------------------------------- */

  const missingNumeric: string[] = [];
  const missingCategorical: string[] = [];
  const missingHeavy: string[] = [];

  for (const issue of dataset.issues) {
    if (issue.kind !== 'missing-values' || !issue.column) continue;
    const column = byName.get(issue.column);
    if (!column) continue;

    const percent = column.missingPercent;
    if (percent > IMPUTE_CEILING_PERCENT) {
      missingHeavy.push(column.name);
      continue;
    }
    if (column.type === 'numeric' || column.type === 'integer') missingNumeric.push(column.name);
    else if (column.type === 'likert' || column.type === 'categorical' || column.type === 'binary') {
      missingCategorical.push(column.name);
    }
  }

  if (missingNumeric.length > 0) {
    // Median rather than mean: the columns that most often have gaps are also
    // the skewed ones, and a mean pulled by a long tail invents a centre that
    // no respondent occupies.
    actions.push({
      kind: 'impute-median',
      columns: missingNumeric,
      reasonKey: 'analysis.clean.reason.imputeNumeric',
      reasonParams: { columns: missingNumeric.length },
      recommended: false,
      destructive: false,
    });
  }

  if (missingCategorical.length > 0) {
    actions.push({
      kind: 'impute-mode',
      columns: missingCategorical,
      reasonKey: 'analysis.clean.reason.imputeCategorical',
      reasonParams: { columns: missingCategorical.length },
      recommended: false,
      destructive: false,
    });
  }

  if (missingHeavy.length > 0) {
    actions.push({
      kind: 'drop-rows-missing',
      columns: missingHeavy,
      reasonKey: 'analysis.clean.reason.heavyMissing',
      reasonParams: { columns: missingHeavy.length, threshold: IMPUTE_CEILING_PERCENT },
      recommended: false,
      destructive: true,
    });
  }

  const outlierColumns = dataset.columns.filter((column) => column.outlierRows.length > 0);
  if (outlierColumns.length > 0) {
    // Never recommended. An outlier is a finding until the researcher decides
    // it is an error, and deleting one to make a test significant is fraud.
    actions.push({
      kind: 'remove-outliers',
      columns: outlierColumns.map((column) => column.name),
      reasonKey: 'analysis.clean.reason.outliers',
      reasonParams: { columns: outlierColumns.length },
      recommended: false,
      destructive: true,
    });
  }

  return actions;
}

/* -------------------------------------------------------------------------- */
/*                                   Apply                                    */
/* -------------------------------------------------------------------------- */

export function applyCleaning(
  dataset: Dataset,
  profile: DatasetProfile,
  actions: CleaningAction[],
): CleaningResult {
  // A deep copy: the caller keeps the dataset it passed in, untouched.
  let columns = [...dataset.columns];
  let rows = dataset.rows.map((row) => [...row]);

  const changes: CleaningChange[] = [];
  const noOps: CleaningReport['noOps'] = [];
  let cellsChanged = 0;

  const indexOf = (name: string) => columns.indexOf(name);
  const profileOf = (name: string) => profile.columns.find((column) => column.name === name);

  const ordered = orderActions(actions);

  for (const action of ordered) {
    const before = { rows: rows.length, columns: columns.length, cells: cellsChanged };

    switch (action.kind) {
      case 'trim-whitespace': {
        for (const name of action.columns) {
          const index = indexOf(name);
          if (index < 0) continue;
          let affected = 0;
          for (const row of rows) {
            const value = row[index];
            if (typeof value === 'string' && value !== value.trim()) {
              row[index] = value.trim();
              affected += 1;
            }
          }
          if (affected > 0) {
            cellsChanged += affected;
            changes.push({ action: action.kind, column: name, affected });
          }
        }
        break;
      }

      case 'normalise-categories': {
        for (const name of action.columns) {
          const index = indexOf(name);
          if (index < 0) continue;
          const canonical = canonicalLabels(rows, index);
          let affected = 0;
          for (const row of rows) {
            const value = row[index];
            if (typeof value !== 'string') continue;
            const target = canonical.get(normaliseLabel(value));
            if (target !== undefined && target !== value) {
              changes.push({ action: action.kind, column: name, affected: 1, before: value, after: target });
              row[index] = target;
              affected += 1;
            }
          }
          cellsChanged += affected;
        }
        break;
      }

      case 'drop-duplicate-rows': {
        const seen = new Set<string>();
        const kept: CellValue[][] = [];
        const removed: number[] = [];
        rows.forEach((row, index) => {
          const key = JSON.stringify(row);
          if (seen.has(key)) removed.push(index);
          else {
            seen.add(key);
            kept.push(row);
          }
        });
        if (removed.length > 0) {
          rows = kept;
          changes.push({ action: action.kind, column: null, affected: removed.length, rows: removed.slice(0, 50) });
        }
        break;
      }

      case 'drop-empty-columns':
      case 'drop-constant-columns': {
        const doomed = new Set(action.columns.filter((name) => indexOf(name) >= 0));
        if (doomed.size === 0) break;
        const keepIndices = columns.map((name, index) => (doomed.has(name) ? -1 : index)).filter((i) => i >= 0);
        columns = keepIndices.map((index) => columns[index] as string);
        rows = rows.map((row) => keepIndices.map((index) => row[index] ?? null));
        changes.push({ action: action.kind, column: null, affected: doomed.size, before: [...doomed].join(', ') });
        break;
      }

      case 'coerce-numeric': {
        for (const name of action.columns) {
          const index = indexOf(name);
          if (index < 0) continue;
          let affected = 0;
          for (const row of rows) {
            const value = row[index];
            if (value === null || value === '') continue;
            if (toNumber(value) === null) {
              // Kept as a change record, so the report can show exactly which
              // stray text was turned into a gap.
              changes.push({
                action: action.kind,
                column: name,
                affected: 1,
                before: String(value),
                after: '',
              });
              row[index] = null;
              affected += 1;
            }
          }
          cellsChanged += affected;
        }
        break;
      }

      case 'impute-median':
      case 'impute-mean': {
        for (const name of action.columns) {
          const index = indexOf(name);
          if (index < 0) continue;
          const values: number[] = [];
          for (const row of rows) {
            const parsed = toNumber(row[index]);
            if (parsed !== null) values.push(parsed);
          }
          if (values.length === 0) continue;
          const fill = action.kind === 'impute-mean' ? mean(values) : median(values);
          const rounded = Number(fill.toFixed(4));
          let affected = 0;
          for (const row of rows) {
            const value = row[index];
            if (value === null || value === '') {
              row[index] = rounded;
              affected += 1;
            }
          }
          if (affected > 0) {
            cellsChanged += affected;
            changes.push({ action: action.kind, column: name, affected, after: String(rounded) });
          }
        }
        break;
      }

      case 'impute-mode': {
        for (const name of action.columns) {
          const index = indexOf(name);
          if (index < 0) continue;
          const present = rows
            .map((row) => row[index])
            .filter((value): value is string | number => value !== null && value !== '');
          const top = mode(present);
          if (!top) continue;
          let affected = 0;
          for (const row of rows) {
            const value = row[index];
            if (value === null || value === '') {
              row[index] = top.value;
              affected += 1;
            }
          }
          if (affected > 0) {
            cellsChanged += affected;
            changes.push({ action: action.kind, column: name, affected, after: String(top.value) });
          }
        }
        break;
      }

      case 'drop-rows-missing': {
        const indices = action.columns.map(indexOf).filter((index) => index >= 0);
        if (indices.length === 0) break;
        const removed: number[] = [];
        const kept = rows.filter((row, index) => {
          const incomplete = indices.some((i) => row[i] === null || row[i] === '');
          if (incomplete) removed.push(index);
          return !incomplete;
        });
        if (removed.length > 0) {
          rows = kept;
          changes.push({ action: action.kind, column: action.columns.join(', '), affected: removed.length, rows: removed.slice(0, 50) });
        }
        break;
      }

      case 'remove-outliers': {
        const doomedRows = new Set<number>();
        for (const name of action.columns) {
          const columnProfile = profileOf(name);
          if (!columnProfile) continue;
          for (const rowIndex of columnProfile.outlierRows) doomedRows.add(rowIndex);
        }
        if (doomedRows.size === 0) break;
        // Row indices come from the profile of the *original* dataset, so this
        // action is only meaningful before any row has been dropped — which is
        // why `orderActions` runs it first among the row-removing steps.
        const kept = rows.filter((_, index) => !doomedRows.has(index));
        changes.push({
          action: action.kind,
          column: action.columns.join(', '),
          affected: rows.length - kept.length,
          rows: [...doomedRows].slice(0, 50),
        });
        rows = kept;
        break;
      }

      case 'flag-outliers':
        break;
    }

    const touched =
      before.rows !== rows.length || before.columns !== columns.length || before.cells !== cellsChanged;
    if (!touched) noOps.push(action.kind);
  }

  const report: CleaningReport = {
    originalRows: dataset.rows.length,
    originalColumns: dataset.columns.length,
    cleanedRows: rows.length,
    cleanedColumns: columns.length,
    rowsRemoved: dataset.rows.length - rows.length,
    columnsRemoved: dataset.columns.length - columns.length,
    cellsChanged,
    changes,
    noOps,
    cleanedAt: new Date().toISOString(),
  };

  return {
    cleaned: {
      columns,
      rows,
      source: `${dataset.source} (cleaned)`,
      skippedRows: 0,
    },
    report,
  };
}

/**
 * Order is not cosmetic here.
 *
 * Value edits run before row removals, so that a row is not dropped for a gap
 * that imputation would have filled. Outlier removal runs before other row
 * removals because its row indices refer to the original table. Column drops
 * run last, when nothing else needs to look a column up by name.
 */
const ORDER: Record<CleaningAction['kind'], number> = {
  'trim-whitespace': 0,
  'normalise-categories': 1,
  'coerce-numeric': 2,
  'impute-mean': 3,
  'impute-median': 3,
  'impute-mode': 3,
  'flag-outliers': 4,
  'remove-outliers': 5,
  'drop-duplicate-rows': 6,
  'drop-rows-missing': 7,
  'drop-empty-columns': 8,
  'drop-constant-columns': 8,
};

function orderActions(actions: CleaningAction[]): CleaningAction[] {
  return [...actions].sort((a, b) => (ORDER[a.kind] ?? 99) - (ORDER[b.kind] ?? 99));
}

/** The variant a group of near-identical labels collapses to: the commonest one. */
function canonicalLabels(rows: CellValue[][], index: number): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const value = row[index];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const key = normaliseLabel(value);
    if (!counts.has(key)) counts.set(key, new Map());
    const variants = counts.get(key)!;
    variants.set(value, (variants.get(value) ?? 0) + 1);
  }

  const canonical = new Map<string, string>();
  for (const [key, variants] of counts) {
    let best = '';
    let bestCount = -1;
    for (const [variant, count] of variants) {
      if (count > bestCount || (count === bestCount && variant.length < best.length)) {
        best = variant;
        bestCount = count;
      }
    }
    canonical.set(key, best);
  }

  return canonical;
}
