/**
 * The data layer's public surface.
 *
 * Everything above this module — routes, services, UI — imports from here and
 * from nowhere deeper, so the internals stay free to change. The layer knows
 * nothing about HTTP, the database, or the AI provider, which is what makes it
 * testable without any of them (`npm run test:analysis`).
 */

export { DataParseError, MAX_COLUMNS, MAX_ROWS, detectDelimiter, parseCsv } from './parse';
export { parseXlsx } from './parse-xlsx';
export { profileDataset } from './profile';
export { applyCleaning, planCleaning } from './clean';
export { reportToText, toCsv } from './serialize';
export * from './types';

import { DataParseError, parseCsv } from './parse';
import { parseXlsx } from './parse-xlsx';
import type { Dataset } from './types';

/** Files this product will read. Anything else is refused with a clear reason. */
export const ACCEPTED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm'] as const;

/** 12 MB: comfortably larger than any survey export, small enough to parse in a request. */
export const MAX_FILE_BYTES = 12 * 1024 * 1024;

/**
 * Reads an uploaded file by looking at its name, then its bytes.
 *
 * The extension decides the reader, but a mislabelled file is common enough
 * that a workbook signature is checked too: `.csv` files renamed from Excel
 * would otherwise produce a wall of binary as "data".
 */
export async function readUpload(file: {
  name: string;
  bytes: ArrayBuffer;
}): Promise<Dataset> {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(file.bytes);

  if (bytes.byteLength === 0) throw new DataParseError('analysis.error.emptyFile');
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new DataParseError('analysis.error.tooLarge', {
      limitMb: Math.round(MAX_FILE_BYTES / (1024 * 1024)),
    });
  }

  // Every .xlsx is a zip, and every zip starts "PK".
  const looksLikeWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || looksLikeWorkbook) {
    if (!looksLikeWorkbook) throw new DataParseError('analysis.error.notAWorkbook');
    return parseXlsx(file.bytes, file.name);
  }

  if (!ACCEPTED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    throw new DataParseError('analysis.error.unsupportedType');
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  return parseCsv(text, file.name);
}
