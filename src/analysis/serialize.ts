import type { CellValue, CleaningReport, Dataset, DatasetProfile } from './types';

/**
 * Writing a dataset back out.
 *
 * CSV is produced here rather than by a library because the requirements are
 * narrow and the failure modes are not: a value containing the delimiter, a
 * quote, or a newline must be quoted or the file silently loses its shape.
 * The BOM is deliberate — without it Excel opens Arabic text as mojibake, and
 * the user concludes the tool corrupted their data.
 */
export function toCsv(dataset: Dataset, delimiter = ','): string {
  const lines: string[] = [];
  lines.push(dataset.columns.map((name) => escapeCsv(name, delimiter)).join(delimiter));

  for (const row of dataset.rows) {
    lines.push(row.map((value) => escapeCsv(formatValue(value), delimiter)).join(delimiter));
  }

  return `﻿${lines.join('\r\n')}\r\n`;
}

function formatValue(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function escapeCsv(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');
  if (!needsQuotes) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * A plain-text account of what cleaning did, meant to be pasted into a
 * methodology section or kept beside the cleaned file as a record.
 */
export function reportToText(
  profile: DatasetProfile,
  report: CleaningReport,
  locale: 'ar' | 'en' = 'ar',
): string {
  const ar = locale === 'ar';
  const lines: string[] = [];

  lines.push(ar ? '# تقرير تنظيف البيانات' : '# Data cleaning report');
  lines.push('');
  lines.push(`${ar ? 'المصدر' : 'Source'}: ${profile.source}`);
  lines.push(`${ar ? 'التاريخ' : 'Date'}: ${report.cleanedAt}`);
  lines.push('');
  lines.push(ar ? '## قبل التنظيف' : '## Before');
  lines.push(`${ar ? 'الصفوف' : 'Rows'}: ${report.originalRows}`);
  lines.push(`${ar ? 'الأعمدة' : 'Columns'}: ${report.originalColumns}`);
  lines.push(
    `${ar ? 'الخلايا المفقودة' : 'Missing cells'}: ${profile.missingCells} ` +
      `(${((1 - profile.completeness) * 100).toFixed(2)}%)`,
  );
  lines.push('');
  lines.push(ar ? '## بعد التنظيف' : '## After');
  lines.push(`${ar ? 'الصفوف' : 'Rows'}: ${report.cleanedRows} (−${report.rowsRemoved})`);
  lines.push(`${ar ? 'الأعمدة' : 'Columns'}: ${report.cleanedColumns} (−${report.columnsRemoved})`);
  lines.push(`${ar ? 'الخلايا المعدَّلة' : 'Cells changed'}: ${report.cellsChanged}`);
  lines.push('');

  if (report.changes.length === 0) {
    lines.push(ar ? 'لم يُجرَ أي تعديل.' : 'No changes were made.');
    return lines.join('\n');
  }

  lines.push(ar ? '## التفاصيل' : '## Details');
  for (const change of report.changes) {
    const where = change.column ? ` — ${change.column}` : '';
    const detail =
      change.before !== undefined && change.after !== undefined
        ? ` (${change.before} → ${change.after})`
        : change.after !== undefined
          ? ` (→ ${change.after})`
          : change.before !== undefined
            ? ` (${change.before})`
            : '';
    lines.push(`- ${change.action}${where}: ${change.affected}${detail}`);
  }

  lines.push('');
  lines.push(
    ar
      ? 'النسخة الأصلية من البيانات محفوظة كما هي ولم تُعدَّل.'
      : 'The original data is kept unchanged.',
  );

  return lines.join('\n');
}
