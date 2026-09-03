/**
 * The document formats, produced as real files.
 *
 * Each returns bytes that the corresponding application opens. That is the bar,
 * and it is not automatic: a PDF with a broken cross-reference table opens in
 * some viewers and not others, and a PPTX missing a relationship entry produces
 * PowerPoint's repair prompt — which a researcher reads as the product being
 * broken.
 *
 * **Arabic is the constraint that shapes the PDF path.** `pdf-lib` embeds the
 * standard fonts, none of which contain Arabic glyphs, and writing Arabic with
 * one produces a blank page or a row of boxes. There is no way around that
 * without embedding a font file, which is a megabyte in the bundle. The
 * limitation is detected and reported rather than producing an empty document
 * the researcher discovers on opening.
 */

import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface DocumentSection {
  heading?: string;
  /** Heading depth, 1 to 6. */
  level?: number;
  /** Paragraphs. Light markers only: `*italic*`, `**bold**`. */
  paragraphs?: string[];
  /** A table, as header row plus body rows. */
  table?: { headers: string[]; rows: (string | number)[][] };
}

export interface DocumentContent {
  title: string;
  subtitle?: string;
  author?: string;
  sections: DocumentSection[];
  /** Formatted reference strings, already in the chosen style. */
  references?: string[];
}

/* -------------------------------------------------------------------------- */
/*                                     PDF                                    */
/* -------------------------------------------------------------------------- */

/** Written by pdf-lib's standard fonts. Anything else needs an embedded file. */
const LATIN_ONLY = /^[\x00-\x7F\u00A0-\u024F\u2010-\u203A\s]*$/;

export interface PdfResult {
  bytes: Uint8Array;
  /** Text that could not be rendered, so the caller can warn rather than lie. */
  unsupportedText: string[];
}

/**
 * A PDF from structured content.
 *
 * Laid out directly rather than through HTML, because rendering HTML needs a
 * browser engine — a hundred megabytes of Chromium for a document this can draw
 * in a few hundred lines.
 */
export async function generatePdf(content: DocumentContent): Promise<PdfResult> {
  const pdf = await PDFDocument.create();

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const unsupportedText: string[] = [];

  const A4 = { width: 595.28, height: 841.89 };
  const margin = 64;
  const width = A4.width - margin * 2;

  let page = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - margin;

  /*
   * Text that the standard fonts cannot draw is replaced rather than thrown at
   * pdf-lib, which raises an error mid-document and loses everything written so
   * far. The replacement is visible, and the caller is told.
   */
  const safe = (text: string): string => {
    if (LATIN_ONLY.test(text)) return text;

    unsupportedText.push(text.slice(0, 80));
    return text.replace(/[^\x00-\x7F\u00A0-\u024F\u2010-\u203A\s]/g, '?');
  };

  const newPage = () => {
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - margin;
  };

  const write = (text: string, size: number, font: typeof regular, gap = 4) => {
    for (const line of wrapText(safe(text), font, size, width)) {
      if (y < margin + size) newPage();

      page.drawText(line, { x: margin, y: y - size, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= size + gap;
    }
  };

  /* Title page. */
  y -= 160;
  write(content.title, 24, bold, 10);

  if (content.subtitle) {
    y -= 8;
    write(content.subtitle, 14, regular, 6);
  }

  if (content.author) {
    y -= 24;
    write(content.author, 12, regular, 6);
  }

  newPage();

  for (const section of content.sections) {
    if (section.heading) {
      y -= 12;
      write(section.heading, section.level === 1 ? 18 : 14, bold, 6);
      y -= 4;
    }

    for (const paragraph of section.paragraphs ?? []) {
      write(stripMarkers(paragraph), 11, regular, 4);
      y -= 6;
    }

    if (section.table) {
      /*
       * Tables as aligned text rather than drawn cells. Ruled tables need
       * column measurement and page-break handling that would double this
       * file's size; monospaced alignment is readable and correct.
       */
      const columns = section.table.headers.length;
      const columnWidth = Math.floor(90 / Math.max(columns, 1));

      write(
        section.table.headers.map((header) => pad(header, columnWidth)).join(' '),
        10,
        bold,
        3,
      );

      for (const row of section.table.rows) {
        write(row.map((cell) => pad(String(cell), columnWidth)).join(' '), 10, regular, 3);
      }

      y -= 8;
    }
  }

  if (content.references && content.references.length > 0) {
    newPage();
    write('References', 18, bold, 8);
    y -= 8;

    for (const reference of content.references) {
      write(stripMarkers(reference), 10, regular, 3);
      y -= 4;
    }
  }

  /* Page numbers, added last so the total is known. */
  const pages = pdf.getPages();

  pages.forEach((current, index) => {
    if (index === 0) return;

    current.drawText(String(index), {
      x: A4.width / 2,
      y: margin / 2,
      size: 9,
      font: regular,
      color: rgb(0.4, 0.4, 0.4),
    });
  });

  return { bytes: await pdf.save(), unsupportedText: [...new Set(unsupportedText)] };
}

function wrapText(
  text: string,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;

      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) lines.push(line);

      /*
       * A single word wider than the page — a long URL or DOI. Broken by
       * character rather than left to overflow into the margin.
       */
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = '';

        for (const char of word) {
          if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }

        line = chunk;
      } else {
        line = word;
      }
    }

    if (line) lines.push(line);
  }

  return lines;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

/** Removes the light formatting markers for formats that cannot render them. */
function stripMarkers(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

/* -------------------------------------------------------------------------- */
/*                                    PPTX                                    */
/* -------------------------------------------------------------------------- */

export interface SlideContent {
  title: string;
  /** Bullet points. Kept short; a slide is not a paragraph. */
  bullets?: string[];
  notes?: string;
  table?: { headers: string[]; rows: (string | number)[][] };
}

/**
 * A PowerPoint file.
 *
 * Written with `pptxgenjs`, which produces the full OOXML package —
 * relationships, content types, the theme — that PowerPoint requires. Building
 * the XML directly is possible and produces the repair prompt on any mistake,
 * which is the failure a researcher shows their supervisor.
 */
export async function generatePptx(
  title: string,
  slides: SlideContent[],
  options: { subtitle?: string; rtl?: boolean } = {},
): Promise<Uint8Array> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const deck = new PptxGenJS();

  deck.layout = 'LAYOUT_16x9';
  deck.rtlMode = options.rtl ?? false;

  /* Title slide. */
  const opening = deck.addSlide();

  opening.addText(title, {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 1.2,
    fontSize: 32,
    bold: true,
    align: options.rtl ? 'right' : 'left',
  });

  if (options.subtitle) {
    opening.addText(options.subtitle, {
      x: 0.5,
      y: 3.4,
      w: 9,
      h: 0.6,
      fontSize: 16,
      color: '666666',
      align: options.rtl ? 'right' : 'left',
    });
  }

  for (const slide of slides) {
    const page = deck.addSlide();

    page.addText(slide.title, {
      x: 0.5,
      y: 0.4,
      w: 9,
      h: 0.8,
      fontSize: 24,
      bold: true,
      align: options.rtl ? 'right' : 'left',
    });

    if (slide.bullets && slide.bullets.length > 0) {
      page.addText(
        slide.bullets.map((text) => ({ text: stripMarkers(text), options: { bullet: true } })),
        {
          x: 0.7,
          y: 1.4,
          w: 8.6,
          h: 3.6,
          fontSize: 16,
          align: options.rtl ? 'right' : 'left',
        },
      );
    }

    if (slide.table) {
      page.addTable(
        [
          slide.table.headers.map((header) => ({
            text: header,
            options: { bold: true, fill: { color: 'F1F1F1' } },
          })),
          ...slide.table.rows.map((row) => row.map((cell) => ({ text: String(cell) }))),
        ],
        { x: 0.5, y: 1.4, w: 9, fontSize: 12, border: { pt: 0.5, color: 'DDDDDD' } },
      );
    }

    if (slide.notes) page.addNotes(slide.notes);
  }

  const buffer = (await deck.write({ outputType: 'nodebuffer' })) as Buffer;
  return new Uint8Array(buffer);
}

/* -------------------------------------------------------------------------- */
/*                                CSV and Markdown                            */
/* -------------------------------------------------------------------------- */

/**
 * A CSV that a spreadsheet opens correctly.
 *
 * Two details that decide whether it does. A UTF-8 byte-order mark, without
 * which Excel on Windows renders Arabic as mojibake — the single most common
 * complaint about exported CSVs in the region. And CRLF line endings, which the
 * specification requires and older parsers depend on.
 */
export function generateCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): Uint8Array {
  const escape = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return '';

    const text = String(value);

    /* Quoted when it contains a delimiter, a quote, or a newline. */
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };

  const lines = [
    headers.map(escape).join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ];

  const body = lines.join('\r\n');
  const bom = '\uFEFF';

  return new TextEncoder().encode(bom + body);
}

/** Markdown from the same structured content the other generators take. */
export function generateMarkdown(content: DocumentContent): Uint8Array {
  const parts: string[] = [`# ${content.title}`];

  if (content.subtitle) parts.push(`*${content.subtitle}*`);
  if (content.author) parts.push(content.author);

  for (const section of content.sections) {
    if (section.heading) {
      parts.push(`${'#'.repeat(Math.min(6, (section.level ?? 2) + 1))} ${section.heading}`);
    }

    for (const paragraph of section.paragraphs ?? []) parts.push(paragraph);

    if (section.table) {
      parts.push(
        [
          `| ${section.table.headers.join(' | ')} |`,
          `| ${section.table.headers.map(() => '---').join(' | ')} |`,
          ...section.table.rows.map((row) => `| ${row.join(' | ')} |`),
        ].join('\n'),
      );
    }
  }

  if (content.references && content.references.length > 0) {
    parts.push('## References');
    for (const reference of content.references) parts.push(reference);
  }

  return new TextEncoder().encode(parts.join('\n\n'));
}

/**
 * Whether a file is structurally what it claims to be.
 *
 * Used by the artifact pipeline before storing anything: a generator that fails
 * halfway can produce bytes that are not a valid file, and storing one means
 * the researcher discovers it when they try to open it.
 */
export async function validateArtifactBytes(
  bytes: Uint8Array,
  kind: string,
  /**
   * Text that must appear inside the file.
   *
   * Structural validity is not enough: a Word file with a correct zip
   * structure and an empty body opens cleanly and contains nothing, and the
   * researcher discovers that rather than the pipeline. When supplied, this
   * confirms the content actually reached the document.
   */
  expectedContent?: string,
): Promise<{ valid: boolean; reason?: string }> {
  if (bytes.length === 0) return { valid: false, reason: 'empty' };

  try {
    if (kind === 'pdf') {
      /* Signature, then a load, which parses the cross-reference table. */
      const header = new TextDecoder().decode(bytes.slice(0, 5));
      if (header !== '%PDF-') return { valid: false, reason: 'not a PDF' };

      const document = await PDFDocument.load(bytes);
      if (document.getPageCount() === 0) return { valid: false, reason: 'no pages' };

      /*
       * A PDF's text cannot be read back without a parser this does not carry,
       * so content is checked by size: a document with pages and almost no
       * bytes is an empty shell.
       */
      if (expectedContent && bytes.length < 1200) {
        return { valid: false, reason: 'appears empty' };
      }

      return { valid: true };
    }

    if (kind === 'docx' || kind === 'pptx' || kind === 'xlsx') {
      /*
       * OOXML files are zips. Opening one and checking for the part that makes
       * it that format catches a truncated write, which is the realistic
       * failure — the bytes look plausible and the application refuses them.
       */
      const zip = await JSZip.loadAsync(bytes);

      const required =
        kind === 'docx'
          ? 'word/document.xml'
          : kind === 'pptx'
            ? 'ppt/presentation.xml'
            : 'xl/workbook.xml';

      if (!zip.file(required)) return { valid: false, reason: `missing ${required}` };
      if (!zip.file('[Content_Types].xml')) return { valid: false, reason: 'missing content types' };

      /*
       * The body must contain something. A zip with the right parts and an
       * empty document opens in Word and shows a blank page — which is a
       * failure the pipeline should catch, not the researcher.
       */
      if (kind === 'docx' || kind === 'pptx') {
        const body = await zip.file(required)?.async('string');
        if (!body || body.length < 400) return { valid: false, reason: 'document body is empty' };

        if (expectedContent) {
          /*
           * OOXML splits text across runs, so a phrase may not appear
           * contiguously. Checked word by word: enough of them present means
           * the content arrived.
           */
          const words = expectedContent
            .split(/\s+/)
            .filter((word) => word.length > 3)
            .slice(0, 12);

          const found = words.filter((word) => body.includes(word)).length;

          if (words.length > 0 && found < Math.ceil(words.length / 3)) {
            return { valid: false, reason: 'expected content not found in document' };
          }
        }
      }

      if (kind === 'xlsx') {
        /* A workbook with no sheet parts opens with a repair prompt. */
        const hasSheet = Object.keys(zip.files).some((name) =>
          /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
        );

        if (!hasSheet) return { valid: false, reason: 'no worksheets' };
      }

      return { valid: true };
    }

    if (kind === 'csv' || kind === 'md' || kind === 'bib' || kind === 'ris' || kind === 'txt') {
      const text = new TextDecoder().decode(bytes);
      if (text.trim().length === 0) return { valid: false, reason: 'empty' };

      if (expectedContent) {
        const words = expectedContent
          .split(/\s+/)
          .filter((word) => word.length > 3)
          .slice(0, 12);

        const found = words.filter((word) => text.includes(word)).length;

        if (words.length > 0 && found < Math.ceil(words.length / 3)) {
          return { valid: false, reason: 'expected content not found' };
        }
      }

      /* Format-specific structure, so a truncated write is caught. */
      if (kind === 'bib' && !text.includes('@')) return { valid: false, reason: 'no entries' };
      if (kind === 'ris' && !text.includes('TY  - ')) return { valid: false, reason: 'no entries' };
      if (kind === 'ris' && !text.includes('ER  - ')) return { valid: false, reason: 'unterminated' };

      return { valid: true };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: String(error).slice(0, 120) };
  }
}
