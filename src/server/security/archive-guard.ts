/**
 * Limits for compressed uploads: DOCX and XLSX are ZIP archives, and a PDF
 * holds zlib streams. A few kilobytes can inflate to gigabytes, and the
 * parsers (JSZip, ExcelJS, zlib) inflate whatever they are given.
 *
 * `inspectZip` reads the archive's central directory itself and **inflates
 * every entry against a hard ceiling** before any parser sees the file. The
 * sizes an archive declares are not trusted — they are written by whoever made
 * the file — so the check is on the bytes actually produced.
 */

import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = {
  /** Entries in one archive. A real workbook or document has dozens to hundreds. */
  maxEntries: 5000,
  /** Inflated size of any one entry. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Inflated size of the whole archive. */
  maxTotalBytes: 160 * 1024 * 1024,
};

/** Inflated size of one PDF stream, and of all of them. */
export const PDF_STREAM_LIMIT = 16 * 1024 * 1024;
export const PDF_TOTAL_LIMIT = 64 * 1024 * 1024;

export class ArchiveRejected extends Error {
  constructor(readonly reason: 'not-a-zip' | 'too-many-entries' | 'entry-too-large' | 'too-large' | 'unsupported' | 'corrupt') {
    super(`archive rejected: ${reason}`);
    this.name = 'ArchiveRejected';
  }
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function centralDirectory(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22 || view.getUint32(0, true) !== 0x04034b50) throw new ArchiveRejected('not-a-zip');

  /* End-of-central-directory record, searched backwards past a possible comment. */
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 65_535); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveRejected('corrupt');

  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new ArchiveRejected('unsupported'); // ZIP64
  if (count > ZIP_LIMITS.maxEntries) throw new ArchiveRejected('too-many-entries');

  const entries: Entry[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) throw new ArchiveRejected('corrupt');
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(bytes: Uint8Array, entry: Entry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.byteLength || view.getUint32(at, true) !== 0x04034b50) throw new ArchiveRejected('corrupt');
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new ArchiveRejected('corrupt');
  return bytes.subarray(start, end);
}

function inflateEntry(bytes: Uint8Array, entry: Entry, limit: number): Buffer {
  const data = entryData(bytes, entry);
  if (entry.method === 0) {
    if (data.byteLength > limit) throw new ArchiveRejected('entry-too-large');
    return Buffer.from(data);
  }
  if (entry.method !== 8) throw new ArchiveRejected('unsupported');
  try {
    return inflateRawSync(data, { maxOutputLength: limit });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || /buffer|maxOutputLength|too large/i.test(String(error))) {
      throw new ArchiveRejected('entry-too-large');
    }
    throw new ArchiveRejected('corrupt');
  }
}

/**
 * Verifies an archive is safe to hand to a parser: bounded entry count, and
 * every entry inflated for real within the per-entry and total ceilings.
 */
export function inspectZip(bytes: Uint8Array): { entries: number; inflatedBytes: number } {
  const entries = centralDirectory(bytes);
  let total = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const remaining = ZIP_LIMITS.maxTotalBytes - total;
    const inflated = inflateEntry(bytes, entry, Math.min(ZIP_LIMITS.maxEntryBytes, remaining + 1));
    total += inflated.byteLength;
    if (total > ZIP_LIMITS.maxTotalBytes) throw new ArchiveRejected('too-large');
  }
  return { entries: entries.length, inflatedBytes: total };
}

/** One entry's contents, inflated within the per-entry ceiling. */
export function readZipEntry(bytes: Uint8Array, name: string): Buffer | null {
  const entry = centralDirectory(bytes).find((candidate) => candidate.name === name);
  return entry ? inflateEntry(bytes, entry, ZIP_LIMITS.maxEntryBytes) : null;
}

/* -------------------------------------------------------------------------- */
/*                               Magic bytes                                  */
/* -------------------------------------------------------------------------- */

export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  /* "%PDF-" within the first kilobyte, where the specification allows it. */
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}
