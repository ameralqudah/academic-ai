/**
 * Word documents from structured content.
 *
 * A DOCX builder already existed, and it takes a *project* — it reads sections
 * from the database, resolves the document type, and orders chapters by the
 * research plan. That is right for exporting a thesis someone has been writing
 * for weeks and wrong for a task that has just produced three sections of prose
 * and needs a file.
 *
 * So this takes the same `DocumentContent` the PDF and Markdown generators take,
 * and produces the same shape of Word file. The project exporter is untouched:
 * two callers with genuinely different inputs, sharing the library rather than
 * one pretending to be the other.
 *
 * **Arabic works here in a way it does not in PDF.** Word embeds fonts from the
 * reader's system, so Arabic renders correctly with no font file shipped —
 * which is why a researcher writing in Arabic should be offered Word rather
 * than PDF, and why this generator matters more than its size suggests.
 */

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

import type { DocumentContent } from './documents';

/** Any Arabic letter means the document should be laid out right to left. */
function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

/**
 * Turns light markers into Word runs.
 *
 * The generators share a convention — `*italic*` and `**bold**` — because
 * producing Word-specific formatting in the citation layer would mean a second
 * implementation for PDF and a third for Markdown. This is where it becomes
 * real formatting.
 */
function runsFrom(text: string, rtl: boolean): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;

  let lastIndex = 0;
  let match = pattern.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), rightToLeft: rtl }));
    }

    const token = match[0];

    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true, rightToLeft: rtl }));
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), italics: true, rightToLeft: rtl }));
    }

    lastIndex = match.index + token.length;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), rightToLeft: rtl }));
  }

  /* An empty paragraph still needs a run, or Word renders nothing at all. */
  return runs.length > 0 ? runs : [new TextRun({ text: '', rightToLeft: rtl })];
}

export async function generateDocx(content: DocumentContent): Promise<Uint8Array> {
  /*
   * Direction decided from the content, not from a setting.
   *
   * A researcher writing in Arabic gets a right-to-left document without asking
   * for one, and a mixed document follows its title — which is what the reader
   * sees first and what sets the expectation for the rest.
   */
  const sampled = [
    content.title,
    content.subtitle ?? '',
    ...content.sections.flatMap((section) => [section.heading ?? '', ...(section.paragraphs ?? [])]),
  ]
    .join(' ')
    .slice(0, 2000);

  const rtl = hasArabic(sampled);
  const alignment = rtl ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const children: (Paragraph | Table)[] = [];

  /* Title page. */
  children.push(
    new Paragraph({
      children: runsFrom(content.title, rtl),
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      bidirectional: rtl,
      spacing: { before: 2400, after: 240 },
    }),
  );

  if (content.subtitle) {
    children.push(
      new Paragraph({
        children: runsFrom(content.subtitle, rtl),
        alignment: AlignmentType.CENTER,
        bidirectional: rtl,
        spacing: { after: 240 },
      }),
    );
  }

  if (content.author) {
    children.push(
      new Paragraph({
        children: runsFrom(content.author, rtl),
        alignment: AlignmentType.CENTER,
        bidirectional: rtl,
        spacing: { after: 480 },
      }),
    );
  }

  children.push(new Paragraph({ text: '', pageBreakBefore: true }));

  for (const section of content.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          children: runsFrom(section.heading, rtl),
          heading: section.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          alignment,
          bidirectional: rtl,
          spacing: { before: 360, after: 180 },
        }),
      );
    }

    for (const paragraph of section.paragraphs ?? []) {
      children.push(
        new Paragraph({
          children: runsFrom(paragraph, rtl),
          alignment,
          bidirectional: rtl,
          spacing: { after: 160, line: 360 },
        }),
      );
    }

    if (section.table) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          /*
           * `visuallyRightToLeft` rather than reversing the columns by hand:
           * Word then mirrors the whole table, which is what a reader of an
           * Arabic document expects and what reversing manually gets wrong for
           * borders and merged cells.
           */
          visuallyRightToLeft: rtl,
          rows: [
            new TableRow({
              tableHeader: true,
              children: section.table.headers.map(
                (header) =>
                  new TableCell({
                    children: [
                      new Paragraph({
                        children: [new TextRun({ text: header, bold: true, rightToLeft: rtl })],
                        alignment,
                        bidirectional: rtl,
                      }),
                    ],
                  }),
              ),
            }),
            ...section.table.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [new TextRun({ text: String(cell), rightToLeft: rtl })],
                            alignment,
                            bidirectional: rtl,
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),
      );

      children.push(new Paragraph({ text: '', spacing: { after: 240 } }));
    }
  }

  if (content.references && content.references.length > 0) {
    children.push(
      new Paragraph({
        children: runsFrom(rtl ? 'المراجع' : 'References', rtl),
        heading: HeadingLevel.HEADING_1,
        alignment,
        bidirectional: rtl,
        pageBreakBefore: true,
        spacing: { after: 240 },
      }),
    );

    for (const reference of content.references) {
      children.push(
        new Paragraph({
          children: runsFrom(reference, rtl),
          alignment,
          bidirectional: rtl,
          /* Hanging indent, which is what every citation style specifies. */
          indent: rtl ? { right: 720, hanging: 720 } : { left: 720, hanging: 720 },
          spacing: { after: 120, line: 360 },
        }),
      );
    }
  }

  const document = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(document);
  return new Uint8Array(buffer);
}
