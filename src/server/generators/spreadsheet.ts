/**
 * The two formats the artifact pipeline was missing.
 *
 * A spreadsheet generator existed and was bound to PLS results — it writes
 * loading matrices and bootstrap tables from a `PlsAnalysis`. That is right for
 * exporting an analysis and wrong for a task that has produced a table of
 * numbers and needs a workbook. The PLS exporter is untouched.
 *
 * Plain text was missing entirely, which surfaced as an unrecognised format
 * quietly producing Markdown — a researcher asking for a text file received one
 * with heading markers in it.
 */

import ExcelJS from 'exceljs';

import type { DocumentContent } from './documents';

export interface Sheet {
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

/**
 * A workbook from one or more tables.
 *
 * Numbers are written as numbers rather than strings, which decides whether the
 * researcher can sort and chart the result or has to retype it. A string that
 * looks like a number is the single most common defect in generated
 * spreadsheets and is invisible until someone tries to use one.
 */
export async function generateXlsx(sheets: Sheet[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Academic AI';
  workbook.created = new Date();

  /*
   * A workbook with no sheets is not a valid file — Excel refuses to open it.
   * An empty sheet is honest and openable.
   */
  const usable = sheets.length > 0 ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }];

  for (const [index, sheet] of usable.entries()) {
    /*
     * Excel forbids these characters in a sheet name and truncates at 31,
     * and violating either produces a file that opens with a repair prompt.
     */
    const safeName =
      (sheet.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) ||
      `Sheet${index + 1}`;

    const worksheet = workbook.addWorksheet(safeName);

    if (sheet.headers.length > 0) {
      const header = worksheet.addRow(sheet.headers);
      header.font = { bold: true };
      /* Frozen, so a long table keeps its headings while the reader scrolls. */
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    for (const row of sheet.rows) {
      worksheet.addRow(
        row.map((cell) => {
          if (cell === null || cell === undefined) return null;
          if (typeof cell === 'number') return cell;

          /*
           * A string that is entirely a number becomes one. A CSV read into a
           * task arrives as strings, and writing them back as text gives the
           * researcher a column they cannot sum.
           */
          const text = String(cell).trim();
          if (text !== '' && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);

          return cell;
        }),
      );
    }

    /* Columns sized to their content, within reason. */
    worksheet.columns.forEach((column) => {
      let widest = 10;

      column.eachCell?.({ includeEmpty: false }, (cell) => {
        widest = Math.max(widest, String(cell.value ?? '').length + 2);
      });

      column.width = Math.min(widest, 60);
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/**
 * Plain text.
 *
 * Not Markdown with the markers stripped — a text file has no headings, so
 * structure is carried by blank lines and underlines, which is what a reader
 * opening it in Notepad expects.
 */
export function generateTxt(content: DocumentContent): Uint8Array {
  const parts: string[] = [content.title, '='.repeat(Math.min(content.title.length, 60))];

  if (content.subtitle) parts.push(content.subtitle);
  if (content.author) parts.push(content.author);

  for (const section of content.sections) {
    if (section.heading) {
      parts.push('', section.heading, '-'.repeat(Math.min(section.heading.length, 60)));
    }

    for (const paragraph of section.paragraphs ?? []) {
      /* The light markers mean nothing here and would read as noise. */
      parts.push(paragraph.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1'));
    }

    if (section.table) {
      /*
       * Tables as aligned columns. A pipe table would be Markdown; padded
       * columns are what a plain-text reader can actually follow.
       */
      const widths = section.table.headers.map((header, index) =>
        Math.max(
          header.length,
          ...section.table!.rows.map((row) => String(row[index] ?? '').length),
        ),
      );

      parts.push(
        '',
        section.table.headers.map((header, index) => header.padEnd(widths[index] ?? 10)).join('  '),
        widths.map((width) => '-'.repeat(width)).join('  '),
        ...section.table.rows.map((row) =>
          row.map((cell, index) => String(cell ?? '').padEnd(widths[index] ?? 10)).join('  '),
        ),
      );
    }
  }

  if (content.references && content.references.length > 0) {
    parts.push('', 'References', '-'.repeat(10));

    for (const reference of content.references) {
      parts.push(reference.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1'));
    }
  }

  return new TextEncoder().encode(parts.join('\n\n'));
}
