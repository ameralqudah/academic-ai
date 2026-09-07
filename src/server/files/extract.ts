import { inflateSync } from 'node:zlib';

import JSZip from 'jszip';

import { logger } from '@/lib/logger';

/**
 * Reading what a researcher uploaded.
 *
 * Uploads have only ever been tabular — CSV, TSV, XLSX — because the product
 * grew out of statistics. But a researcher's folder is mostly papers, and
 * "what does the study I uploaded say about sample size" was not a question
 * this could answer at all: the file went in as rows or not at all.
 *
 * **Structure is kept, not flattened.** A paper's headings say what its parts
 * are, and a retrieval that returns "page 4" is far less useful than one that
 * returns "the Methods section". Flattening to a wall of text throws away the
 * thing that makes an academic document navigable.
 *
 * **No new dependency.** DOCX is a zip of XML and `jszip` is already here for
 * the generators; PDF text extraction is done from the content streams the
 * file already contains. A parser that handles every PDF ever written is a
 * library, and this is not trying to be one — it reads the ordinary case and
 * says so when it cannot.
 */

export interface ExtractedSection {
  /** The heading this text sits under, where the document has one. */
  heading: string;
  /** Paragraphs, in order. */
  paragraphs: string[];
}

export interface ExtractedDocument {
  sections: ExtractedSection[];
  /** Total words, for deciding whether extraction actually worked. */
  wordCount: number;
  /**
   * What could not be read.
   *
   * A scanned PDF has no text layer, and returning an empty document would
   * have the researcher believe their file was understood. Named so the caller
   * can say why rather than silently knowing nothing.
   */
  limitation: 'none' | 'no-text-layer' | 'unsupported-format' | 'empty';
}

/** File extensions this can read. Anything else is reported, not guessed at. */
export const READABLE_EXTENSIONS = ['.docx', '.pdf', '.txt', '.md'] as const;

export function isReadableDocument(filename: string): boolean {
  const lower = filename.toLowerCase();
  return READABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Text and structure from a document's bytes.
 *
 * Never throws for a file it cannot read: an unreadable upload is a normal
 * event — a scan, a protected file, a format nobody anticipated — and the
 * caller needs to tell the researcher, not to handle an exception.
 */
export async function extractDocument(
  bytes: Uint8Array,
  filename: string,
): Promise<ExtractedDocument> {
  const lower = filename.toLowerCase();

  try {
    if (lower.endsWith('.docx')) return await extractDocx(bytes);
    if (lower.endsWith('.pdf')) return extractPdf(bytes);
    if (lower.endsWith('.txt') || lower.endsWith('.md')) return extractPlain(bytes);
  } catch (error) {
    logger.warn('extract.failed', { filename, error: String(error).slice(0, 200) });
    return { sections: [], wordCount: 0, limitation: 'unsupported-format' };
  }

  return { sections: [], wordCount: 0, limitation: 'unsupported-format' };
}

/**
 * DOCX, which is a zip containing `word/document.xml`.
 *
 * Read directly rather than through a conversion library: the structure needed
 * here is paragraphs and heading levels, both of which are one attribute away
 * in the XML, and a converter would produce HTML that then has to be parsed
 * back into the same shape.
 */
async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file('word/document.xml')?.async('string');

  if (!documentXml) return { sections: [], wordCount: 0, limitation: 'unsupported-format' };

  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { heading: '', paragraphs: [] };
  let words = 0;

  /* Each `<w:p>` is a paragraph; its style tells whether it is a heading. */
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const paragraphXml = match[1] ?? '';

    /* Text lives in `<w:t>` runs, which a single paragraph may have many of. */
    const text = [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((run) => decodeXml(run[1] ?? ''))
      .join('')
      .trim();

    if (!text) continue;

    const isHeading = /w:val="Heading\d|w:val="Title"/.test(paragraphXml);

    if (isHeading) {
      /* A new heading closes the previous section, if it held anything. */
      if (current.heading || current.paragraphs.length > 0) sections.push(current);
      current = { heading: text, paragraphs: [] };
    } else {
      current.paragraphs.push(text);
    }

    words += text.split(/\s+/).length;
  }

  if (current.heading || current.paragraphs.length > 0) sections.push(current);

  return {
    sections,
    wordCount: words,
    limitation: words === 0 ? 'empty' : 'none',
  };
}

/**
 * PDF, from the text-showing operators in its content streams.
 *
 * Handles uncompressed and Flate-compressed streams, which covers documents
 * produced by ordinary writing tools. It does not handle every PDF: a scan has
 * no text at all, and an unusual encoding produces mojibake rather than words.
 * Both are detected by the word count and reported.
 *
 * **Structure is not recoverable here.** A PDF records positions, not
 * headings, so everything lands in one section — which is honest. Inferring
 * headings from font size would be a guess presented as structure.
 */
function extractPdf(bytes: Uint8Array): ExtractedDocument {
  const buffer = Buffer.from(bytes);

  /*
   * Compressed streams decompressed first.
   *
   * Almost every PDF written by a real tool uses FlateDecode — the text is
   * there and unreadable as raw bytes, so reading the file directly finds
   * nothing and reports a scan. That misdiagnosis is worse than failing: it
   * tells the researcher their paper has no text layer when it does.
   */
  const raw = buffer.toString('latin1') + decompressStreams(buffer);
  const pieces: string[] = [];

  /*
   * Text is shown by `Tj` and `TJ` operators. The parenthesised strings before
   * them are what a reader sees; everything else is layout.
   */
  for (const match of raw.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj/g)) {
    pieces.push(unescapePdf(match[0].slice(1, match[0].lastIndexOf(')'))));
  }

  /*
   * Hex strings, which is how many writers encode text: `<50617274>` instead
   * of `(Part)`. Both forms are ordinary and a reader that handled only
   * parentheses found nothing in files written by pdf-lib among others —
   * reporting a scan for a document whose text was right there.
   */
  for (const match of raw.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    pieces.push(decodeHexString(match[1] ?? ''));
  }

  for (const match of raw.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
    const inner = match[1] ?? '';
    const parts = [
      ...[...inner.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((part) =>
        unescapePdf(part[0].slice(1, -1)),
      ),
      ...[...inner.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((part) => decodeHexString(part[1] ?? '')),
    ];

    if (parts.length > 0) pieces.push(parts.join(''));
  }

  const text = pieces.join(' ').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(/\s+/).length : 0;

  /*
   * A PDF with no extractable text is a scan, or a stream this cannot open.
   * Saying so beats returning nothing and letting the researcher think that is
   * what their paper contains.
   *
   * The threshold is deliberately low. It was twenty, which reported a scan
   * for a genuine one-page document — and a false "this is a scan" is worse
   * than a thin extraction, because it sends the researcher to run OCR on a
   * file that never needed it.
   */
  if (words < 3) {
    return { sections: [], wordCount: words, limitation: 'no-text-layer' };
  }

  return {
    sections: [{ heading: '', paragraphs: splitParagraphs(text) }],
    wordCount: words,
    limitation: 'none',
  };
}

/**
 * The contents of a PDF's compressed streams.
 *
 * Each `stream ... endstream` pair preceded by a FlateDecode filter is
 * inflated. Failures are skipped rather than raised: a PDF may hold images and
 * fonts in the same compressed form, and one unreadable stream should not stop
 * the text from being read.
 */
function decompressStreams(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const parts: string[] = [];

  for (const match of raw.matchAll(/\/FlateDecode[\s\S]{0,200}?stream\r?\n/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;

    try {
      parts.push(inflateSync(buffer.subarray(start, end)).toString('latin1'));
    } catch {
      /* An image or a font, not text. */
    }
  }

  return parts.join('\n');
}

/** Plain text and Markdown, where `#` marks a heading. */
function extractPlain(bytes: Uint8Array): ExtractedDocument {
  const text = Buffer.from(bytes).toString('utf8');

  const sections: ExtractedSection[] = [];
  let current: ExtractedSection = { heading: '', paragraphs: [] };

  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);

    if (heading) {
      if (current.heading || current.paragraphs.length > 0) sections.push(current);
      current = { heading: heading[1] ?? '', paragraphs: [] };
    } else {
      current.paragraphs.push(trimmed);
    }
  }

  if (current.heading || current.paragraphs.length > 0) sections.push(current);

  const words = text.split(/\s+/).filter(Boolean).length;

  return { sections, wordCount: words, limitation: words === 0 ? 'empty' : 'none' };
}

/**
 * A long run of text split into paragraphs.
 *
 * PDF extraction produces one stream with no paragraph marks, so sentences are
 * grouped instead — enough to give retrieval something to return that is not
 * the whole document.
 */
function splitParagraphs(text: string): string[] {
  const sentences = text.match(/[^.!?؟]+[.!?؟]+/g) ?? [text];
  const paragraphs: string[] = [];

  for (let index = 0; index < sentences.length; index += 4) {
    paragraphs.push(sentences.slice(index, index + 4).join(' ').trim());
  }

  return paragraphs.filter(Boolean);
}

/**
 * A PDF hex string, `<50617274>`, as the characters it encodes.
 *
 * Two hex digits per byte. A UTF-16 string appears as four digits per
 * character with a leading zero byte for Latin text, which the zero filter
 * below handles — enough for the ordinary case without pretending to decode
 * every encoding a PDF may declare.
 */
function decodeHexString(hex: string): string {
  const digits = hex.replace(/\s/g, '');
  const bytes: number[] = [];

  for (let index = 0; index + 1 < digits.length; index += 2) {
    bytes.push(parseInt(digits.slice(index, index + 2), 16));
  }

  return String.fromCharCode(...bytes.filter((byte) => byte !== 0));
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function unescapePdf(text: string): string {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\([()\\])/g, '$1');
}
