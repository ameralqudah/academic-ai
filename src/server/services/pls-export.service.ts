/**
 * Exporting a PLS-SEM report.
 *
 * Two formats because researchers need them for different reasons, and giving
 * one would leave half the work undone.
 *
 * **Word** is prose plus formatted tables — the thing that goes into chapter
 * four. It carries the interpretations, so what arrives is not a dump of
 * coefficients but the report as it reads on screen.
 *
 * **Excel** is the numbers alone, one sheet per part of the model. A supervisor
 * asks for the loadings; a reviewer wants the HTMT matrix; a co-author
 * reformats the path table to a different journal's style. None of that is
 * possible with a Word table, and all of it is routine with a spreadsheet.
 *
 * The report arrives already resolved into sentences — the caller passes a
 * rendering function, because the message files live on the client side of the
 * i18n boundary and this module has no business reaching across it. That also
 * means the same export produces Arabic or English from the same code path
 * rather than two.
 */

import ExcelJS from 'exceljs';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type { PlsReport, ReportSection } from '@/analysis/inference/pls/report';

/**
 * Renders a message key with its parameters.
 *
 * Supplied by the caller rather than imported. The message files are loaded
 * through next-intl, which belongs to the request; a service that reached into
 * them directly would have to duplicate that loading and could drift from what
 * the interface shows.
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface PlsExportInput {
  report: PlsReport;
  translate: Translate;
  locale: 'ar' | 'en';
  projectTitle?: string | null;
  datasetName?: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                    Word                                    */
/* -------------------------------------------------------------------------- */

export async function exportPlsToWord(input: PlsExportInput): Promise<Buffer> {
  const rtl = input.locale === 'ar';
  const t = input.translate;
  const align = rtl ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: align,
      bidirectional: rtl,
      children: [
        new TextRun({
          text: t('analysis.pls.export.title'),
          rightToLeft: rtl,
          bold: true,
        }),
      ],
    }),
  );

  if (input.projectTitle) {
    children.push(
      paragraph(input.projectTitle, { rtl, align, italics: true }),
    );
  }

  /*
   * The verdict first, on its own, because it is the one line a supervisor
   * reads before deciding whether to read the rest.
   */
  children.push(
    paragraph(t(input.report.verdict.key, input.report.verdict.params), {
      rtl,
      align,
      bold: true,
    }),
  );

  children.push(new Paragraph({ text: '' }));

  for (const section of input.report.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        alignment: align,
        bidirectional: rtl,
        children: [new TextRun({ text: t(section.titleKey, sectionParams(section)), rightToLeft: rtl, bold: true })],
      }),
    );

    for (const finding of section.findings) {
      children.push(paragraph(t(finding.key, finding.params), { rtl, align }));

      /*
       * Actions are indented and marked, so the reader can tell what the data
       * showed from what the tool suggests they do about it. Conflating the two
       * is how a suggestion becomes a finding in someone's write-up.
       */
      if (finding.action) {
        children.push(
          paragraph(`← ${t(finding.action.key, finding.action.params)}`, {
            rtl,
            align,
            italics: true,
            indent: true,
          }),
        );
      }
    }

    if (section.table && section.table.rows.length > 0) {
      children.push(new Paragraph({ text: '' }));
      children.push(buildWordTable(section.table, t, rtl));
    }

    children.push(new Paragraph({ text: '' }));
  }

  /*
   * The provenance note. A reader deserves to know the numbers came from a
   * named method with a stated validation basis — and the claim is worded
   * exactly as narrowly as it should be: validated against published results
   * and mathematical properties, not against a commercial package nobody ran.
   */
  children.push(paragraph(t('analysis.pls.export.provenance'), { rtl, align, italics: true }));

  const document = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(document);
}

function buildWordTable(
  table: NonNullable<ReportSection['table']>,
  t: Translate,
  rtl: boolean,
): Table {
  const align = rtl ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const header = new TableRow({
    tableHeader: true,
    children: table.headerKeys.map(
      (key) =>
        new TableCell({
          children: [
            new Paragraph({
              alignment: align,
              bidirectional: rtl,
              children: [new TextRun({ text: t(key), rightToLeft: rtl, bold: true })],
            }),
          ],
        }),
    ),
  });

  const rows = table.rows.map((row, index) => {
    /*
     * Failing rows are marked in bold rather than by colour. Colour does not
     * survive a black-and-white print of a thesis, and a reviewer reading a
     * paper copy should still see which indicators were flagged.
     */
    const flagged = table.flaggedRows.includes(index);

    return new TableRow({
      children: row.map(
        (cell) =>
          new TableCell({
            children: [
              new Paragraph({
                alignment: align,
                bidirectional: rtl,
                children: [
                  new TextRun({
                    text: String(cell),
                    rightToLeft: rtl && typeof cell === 'string',
                    bold: flagged,
                  }),
                ],
              }),
            ],
          }),
      ),
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    /*
     * Column order reversed for Arabic. Word does not mirror a table for an RTL
     * document, so the first column would sit on the left of an
     * otherwise-right-to-left page — which reads as broken rather than as a
     * design choice.
     */
    visuallyRightToLeft: rtl,
    rows: [header, ...rows],
  });
}

function paragraph(
  text: string,
  options: { rtl: boolean; align: (typeof AlignmentType)[keyof typeof AlignmentType]; bold?: boolean; italics?: boolean; indent?: boolean },
): Paragraph {
  return new Paragraph({
    alignment: options.align,
    bidirectional: options.rtl,
    ...(options.indent ? { indent: { start: 400 } } : {}),
    children: [
      new TextRun({
        text,
        rightToLeft: options.rtl,
        bold: options.bold ?? false,
        italics: options.italics ?? false,
      }),
    ],
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Excel                                    */
/* -------------------------------------------------------------------------- */

/**
 * One sheet per part of the model.
 *
 * Split rather than stacked on one sheet, because each answers a different
 * question and gets copied somewhere different. A single sheet with five tables
 * separated by blank rows is a file nobody can sort or filter.
 */
export async function exportPlsToExcel(input: PlsExportInput): Promise<Buffer> {
  const t = input.translate;
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Academic AI';
  workbook.created = new Date();

  /* A summary sheet first, so the file opens on something readable. */
  const summary = workbook.addWorksheet(t('analysis.pls.export.sheet.summary'));
  summary.views = [{ rightToLeft: input.locale === 'ar' }];

  summary.addRow([t('analysis.pls.export.title')]);
  (summary.getRow(1).getCell(1).font = { bold: true, size: 14 });

  if (input.projectTitle) summary.addRow([input.projectTitle]);
  if (input.datasetName) summary.addRow([input.datasetName]);

  summary.addRow([]);
  summary.addRow([t(input.report.verdict.key, input.report.verdict.params)]);
  summary.addRow([]);

  /*
   * The findings, with their severity in a column of their own so the sheet can
   * be filtered to the problems — which is the first thing anyone does with a
   * list this long.
   */
  summary.addRow([
    t('analysis.pls.export.column.severity'),
    t('analysis.pls.export.column.finding'),
    t('analysis.pls.export.column.action'),
  ]);
  summary.lastRow!.font = { bold: true };

  for (const section of input.report.sections) {
    for (const finding of section.findings) {
      summary.addRow([
        t(`analysis.pls.export.severity.${finding.severity}`),
        t(finding.key, finding.params),
        finding.action ? t(finding.action.key, finding.action.params) : '',
      ]);
    }
  }

  summary.getColumn(1).width = 14;
  summary.getColumn(2).width = 90;
  summary.getColumn(3).width = 70;
  summary.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  summary.getColumn(3).alignment = { wrapText: true, vertical: 'top' };

  /* Then one sheet per table in the report. */
  let index = 0;
  for (const section of input.report.sections) {
    if (!section.table || section.table.rows.length === 0) continue;
    index += 1;

    /*
     * Excel refuses sheet names over 31 characters or containing : \ / ? * [ ],
     * and throws rather than truncating. A construct named after a long Arabic
     * phrase would otherwise fail the whole export.
     */
    const name = safeSheetName(t(section.titleKey, sectionParams(section)), index);
    const sheet = workbook.addWorksheet(name);
    sheet.views = [{ rightToLeft: input.locale === 'ar' }];

    sheet.addRow(section.table.headerKeys.map((key) => t(key)));
    sheet.getRow(1).font = { bold: true };

    section.table.rows.forEach((row, rowIndex) => {
      const added = sheet.addRow(row);
      if (section.table?.flaggedRows.includes(rowIndex)) added.font = { bold: true };
    });

    sheet.columns.forEach((column) => {
      column.width = 18;
    });
    if (sheet.columns[0]) sheet.columns[0].width = 28;

    /* Freeze the header so a long table stays readable while scrolling. */
    sheet.views = [{ state: 'frozen', ySplit: 1, rightToLeft: input.locale === 'ar' }];
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/* -------------------------------------------------------------------------- */
/*                                  Support                                   */
/* -------------------------------------------------------------------------- */

/**
 * A sheet name Excel will accept.
 *
 * The index prefix guarantees uniqueness: two constructs with names that
 * truncate to the same 31 characters would otherwise collide, and ExcelJS
 * throws on a duplicate name rather than renaming.
 */
function safeSheetName(title: string, index: number): string {
  const cleaned = title.replace(/[:\\/?*[\]]/g, ' ').trim();
  const prefix = `${index}. `;
  return `${prefix}${cleaned}`.slice(0, 31);
}

/** Construct sections name their construct in the title. */
function sectionParams(section: ReportSection): Record<string, string | number> {
  const first = section.findings[0];
  return first?.params?.construct ? { construct: first.params.construct } : {};
}
