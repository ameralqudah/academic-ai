import ExcelJS from 'exceljs';

import { DataParseError, fromRecords, MAX_COLUMNS, MAX_ROWS } from './parse';
import type { Dataset } from './types';

/**
 * Reader for `.xlsx` / `.xlsm` workbooks.
 *
 * Kept in its own module because ExcelJS is large: importing it from the CSV
 * path would pull a spreadsheet engine into requests that only ever see text.
 *
 * Two decisions worth stating. Formulas are read as their last cached result,
 * because that is what the researcher saw on screen and what they mean by "my
 * data"; a formula string would be meaningless to every statistic downstream.
 * And dates are converted to ISO text rather than left as `Date` objects, so a
 * dataset stays a plain, serialisable value.
 */
export async function parseXlsx(buffer: ArrayBuffer, source: string): Promise<Dataset> {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new DataParseError('analysis.error.unreadableWorkbook');
  }

  const sheet =
    workbook.worksheets.find((candidate) => candidate.rowCount > 1) ?? workbook.worksheets[0];

  if (!sheet) throw new DataParseError('analysis.error.noSheets');
  if (sheet.columnCount > MAX_COLUMNS) {
    throw new DataParseError('analysis.error.tooManyColumns', {
      limit: MAX_COLUMNS,
      found: sheet.columnCount,
    });
  }

  const records: string[][] = [];
  const width = Math.min(sheet.columnCount, MAX_COLUMNS);

  sheet.eachRow({ includeEmpty: false }, (row) => {
    // +1: the header row is not part of the data budget.
    if (records.length > MAX_ROWS + 1) return;
    const values: string[] = [];
    for (let column = 1; column <= width; column += 1) {
      values.push(cellToText(row.getCell(column).value));
    }
    records.push(values);
  });

  if (records.length === 0) throw new DataParseError('analysis.error.emptyFile');

  return fromRecords(records, source);
}

/** Every cell shape ExcelJS can hand back, reduced to the text the user saw. */
function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  if (typeof value === 'object') {
    if ('result' in value && value.result !== undefined && value.result !== null) {
      return cellToText(value.result as ExcelJS.CellValue);
    }
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return 'text' in value && typeof value.text === 'string' ? value.text : value.hyperlink;
    }
    // A formula that has never been calculated has no value to report, and
    // inventing one would be worse than an empty cell.
    if ('formula' in value || 'sharedFormula' in value) return '';
  }

  return '';
}
