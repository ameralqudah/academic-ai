/**
 * Saved datasets — the layer between an uploaded file and everything that
 * later wants to use it.
 *
 * The existing `analysis.service` handles files that pass through: upload,
 * inspect, download, gone. That is the right shape for a one-off cleanup and
 * the wrong shape for everything phase two adds. A conversation that says
 * "analyse this file" and then "now compare the two groups" needs the file to
 * still be there on the second message, and a results chapter written three
 * weeks later needs to know which file its numbers came from.
 *
 * So this service keeps files. Which means it inherits the responsibilities
 * that come with keeping other people's research data, and those shape almost
 * every decision below.
 *
 * **The bytes are stored once and never re-uploaded.** Rows are parsed from
 * storage on demand rather than kept in the database, because a twelve-megabyte
 * spreadsheet in a jsonb column makes every query that touches the table slow
 * for the sake of data that is needed only while an analysis runs.
 *
 * **Cleaning derives, never overwrites.** A cleaned copy is a new row and a new
 * object, linked to its parent. The researcher's own file stays exactly as they
 * uploaded it, including its mistakes — which matters when a supervisor asks
 * what the raw data looked like.
 *
 * **Ownership is checked on the row, every time.** Not on the storage key,
 * which is a location rather than a credential, and not once at the start of a
 * session.
 */

import { randomUUID } from 'node:crypto';

import {
  applyCleaning,
  DataParseError,
  MAX_FILE_BYTES,
  planCleaning,
  profileDataset,
  readUpload,
  toCsv,
  type CleaningAction,
  type Dataset as ParsedDataset,
  type DatasetProfile,
} from '@/analysis';
import { logger } from '@/lib/logger';
import type { Dataset as DatasetRow } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import {
  checksumOf,
  datasetKey,
  keyBelongsTo,
  LocalStorageProvider,
  storageProvider,
  StorageError,
} from '@/server/storage';

/**
 * Rows the interactive analysis works on.
 *
 * The whole file is stored; this is how much of it is loaded to compute a
 * statistic in a chat. Above this the wait stops feeling interactive, and a
 * questionnaire study with more than five thousand complete responses is rare
 * enough that the ones which have them can be handled deliberately later.
 *
 * The parser's own `MAX_ROWS` is higher and stays where it is: truncation is
 * reported to the user either way, and reporting two different numbers for two
 * different reasons is worse than one conservative one.
 */
export const INTERACTIVE_ROW_LIMIT = 5_000;

/** How many datasets one user may keep. A ceiling, not a quota to sell against. */
const MAX_DATASETS_PER_USER = 100;

export interface SaveDatasetInput {
  userId: string;
  file: { name: string; bytes: ArrayBuffer };
  projectId?: string | null;
  conversationId?: string | null;
}

export interface SavedDataset {
  dataset: DatasetRow;
  profile: DatasetProfile;
  proposals: CleaningAction[];
  preview: { columns: string[]; rows: (string | number | boolean | null)[][] };
  notices: { key: string; params?: Record<string, string | number> }[];
}

const PREVIEW_ROWS = 15;

/* -------------------------------------------------------------------------- */
/*                                   Saving                                   */
/* -------------------------------------------------------------------------- */

export async function saveUpload(input: SaveDatasetInput): Promise<SavedDataset> {
  const { userId, file } = input;

  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    throw new AppError(
      'VALIDATION',
      'The file is larger than the upload limit.',
      'حجم الملف أكبر من الحد المسموح به.',
    );
  }

  const existing = await datasetsRepo.listByUser(userId, MAX_DATASETS_PER_USER + 1);
  if (existing.length >= MAX_DATASETS_PER_USER) {
    throw new AppError(
      'VALIDATION',
      `You are storing the maximum of ${MAX_DATASETS_PER_USER} files. Delete one to upload another.`,
      `لديك الحد الأقصى وهو ${MAX_DATASETS_PER_USER} ملفًا. احذف ملفًا لرفع آخر.`,
    );
  }

  const parsed = await parse(file);
  const profile = profileDataset(parsed);

  /*
   * The id is generated before the write because it is part of the storage key.
   * The object is written first and the row second: a written object with no
   * row is an orphan a sweep can find, while a row pointing at bytes that were
   * never written is a dataset that looks fine until someone opens it.
   */
  const datasetId = randomUUID();
  const extension = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
  const key = datasetKey({ userId, datasetId, kind: 'ORIGINAL', extension: 'csv' });

  /*
   * Stored as CSV rather than as the original bytes.
   *
   * A deliberate trade. The exact uploaded workbook is not kept, which means an
   * Excel file's formatting and formulas are lost — but what is kept is exactly
   * what the analysis will use, so a result can never disagree with the stored
   * file. Keeping the original binary and re-parsing it on every read would
   * risk a parser change silently altering a saved dataset's numbers.
   */
  const csv = toCsv(parsed);
  const bytes = new TextEncoder().encode(csv);

  try {
    await storageProvider().put(key, bytes, 'text/csv');
  } catch (error) {
    logger.error('dataset.storeFailed', { userId, error: String(error) });
    throw new AppError(
      'INTERNAL',
      'The file could not be stored. Please try again.',
      'تعذّر حفظ الملف. حاول مرة أخرى.',
    );
  }

  let dataset: DatasetRow;
  try {
    dataset = await datasetsRepo.create({
      id: datasetId,
      userId,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      kind: 'ORIGINAL',
      originalName: file.name.slice(0, 255),
      storageKey: key,
      mimeType: 'text/csv',
      byteSize: bytes.byteLength,
      checksum: checksumOf(bytes),
      rowCount: profile.rowCount,
      columnCount: profile.columnCount,
      truncatedTo: parsed.truncatedTo ?? null,
      profile: profile as unknown as Record<string, unknown>,
    });
  } catch (error) {
    // The row failed, so the object it points at is now unreachable. Remove it
    // rather than leaving a stranger's data on disk with nothing referencing it.
    await storageProvider()
      .delete(key)
      .catch(() => undefined);
    throw error;
  }

  logger.info('dataset.saved', {
    datasetId,
    rows: profile.rowCount,
    columns: profile.columnCount,
    bytes: bytes.byteLength,
    sourceFormat: extension,
  });

  return {
    dataset,
    profile,
    proposals: planCleaning(profile),
    preview: { columns: parsed.columns, rows: parsed.rows.slice(0, PREVIEW_ROWS) },
    notices: noticesFor(parsed),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Reading                                   */
/* -------------------------------------------------------------------------- */

/** The row, or a refusal. Never a row belonging to someone else. */
export async function requireOwned(datasetId: string, userId: string): Promise<DatasetRow> {
  const dataset = await datasetsRepo.findOwned(datasetId, userId);

  if (!dataset) {
    /*
     * The same message whether the dataset does not exist or belongs to another
     * user. Distinguishing them would let anyone with an id confirm whether it
     * is real — which is how an enumeration attack learns the shape of a system.
     */
    throw new AppError('NOT_FOUND', 'That file was not found.', 'لم يُعثر على الملف.');
  }

  /*
   * The key is checked against the owner as well as the row. These two can only
   * disagree if something upstream is wrong, and a request that reaches an
   * inconsistent state should stop rather than serve a file.
   */
  if (!keyBelongsTo(dataset.storageKey, userId)) {
    logger.error('dataset.keyOwnerMismatch', { datasetId, userId });
    throw new AppError('FORBIDDEN', 'That file was not found.', 'لم يُعثر على الملف.');
  }

  return dataset;
}

export interface LoadedDataset {
  row: DatasetRow;
  data: ParsedDataset;
  profile: DatasetProfile;
  /** Set when the analysis window was smaller than the stored file. */
  truncatedTo?: number;
}

/**
 * Loads the rows an analysis will run on.
 *
 * The profile is recomputed rather than read from the stored column, because
 * the stored one describes the whole file and this describes the window that
 * was actually loaded. Reporting a profile for five thousand rows next to a
 * result computed on them keeps the two consistent.
 */
export async function loadForAnalysis(
  datasetId: string,
  userId: string,
  rowLimit = INTERACTIVE_ROW_LIMIT,
): Promise<LoadedDataset> {
  const row = await requireOwned(datasetId, userId);

  let bytes: Uint8Array;
  try {
    bytes = (await storageProvider().get(row.storageKey)).bytes;
  } catch (error) {
    logger.error('dataset.readFailed', {
      datasetId,
      reason: error instanceof StorageError ? error.reasonKey : 'unknown',
    });
    throw new AppError(
      'INTERNAL',
      'The stored file could not be read.',
      'تعذّرت قراءة الملف المحفوظ.',
    );
  }

  const parsed = await parse({ name: row.originalName, bytes: bytes.buffer as ArrayBuffer });

  const windowed: ParsedDataset =
    parsed.rows.length > rowLimit
      ? { ...parsed, rows: parsed.rows.slice(0, rowLimit), truncatedTo: rowLimit }
      : parsed;

  return {
    row,
    data: windowed,
    profile: profileDataset(windowed),
    ...(windowed.truncatedTo ? { truncatedTo: windowed.truncatedTo } : {}),
  };
}

/** The stored bytes, for the download route. Ownership is checked first. */
export async function downloadOwned(
  datasetId: string,
  userId: string,
): Promise<{ filename: string; csv: string }> {
  const row = await requireOwned(datasetId, userId);
  const object = await storageProvider().get(row.storageKey);
  return {
    filename: row.originalName.replace(/\.(xlsx|xls)$/i, '.csv'),
    csv: new TextDecoder().decode(object.bytes),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Cleaning                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produces a cleaned copy as a new dataset.
 *
 * The parent is untouched. This is the requirement that stops the tool from
 * being able to damage a researcher's data at all: every cleaning operation
 * adds, and nothing rewrites.
 */
export async function saveCleanedCopy(input: {
  datasetId: string;
  userId: string;
  actions: CleaningAction[];
}): Promise<{ dataset: DatasetRow; profile: DatasetProfile; report: unknown }> {
  const source = await loadForAnalysis(input.datasetId, input.userId, Number.MAX_SAFE_INTEGER);

  if (source.row.kind === 'CLEANED') {
    throw new AppError(
      'VALIDATION',
      'This is already a cleaned copy. Clean the original instead.',
      'هذه نسخة منظَّفة بالفعل. نظّف الملف الأصلي بدلًا منها.',
    );
  }

  const { cleaned, report } = applyCleaning(source.data, source.profile, input.actions);
  const profile = profileDataset(cleaned);

  const datasetId = randomUUID();
  const key = datasetKey({
    userId: input.userId,
    datasetId,
    kind: 'CLEANED',
    extension: 'csv',
  });

  const bytes = new TextEncoder().encode(toCsv(cleaned));
  await storageProvider().put(key, bytes, 'text/csv');

  let row: DatasetRow;
  try {
    row = await datasetsRepo.create({
      id: datasetId,
      userId: input.userId,
      projectId: source.row.projectId,
      conversationId: source.row.conversationId,
      kind: 'CLEANED',
      parentDatasetId: source.row.id,
      originalName: source.row.originalName,
      storageKey: key,
      mimeType: 'text/csv',
      byteSize: bytes.byteLength,
      checksum: checksumOf(bytes),
      rowCount: profile.rowCount,
      columnCount: profile.columnCount,
      profile: profile as unknown as Record<string, unknown>,
    });
  } catch (error) {
    await storageProvider()
      .delete(key)
      .catch(() => undefined);
    throw error;
  }

  logger.info('dataset.cleaned', {
    parent: source.row.id,
    datasetId,
    rowsBefore: source.profile.rowCount,
    rowsAfter: profile.rowCount,
  });

  return { dataset: row, profile, report };
}

/* -------------------------------------------------------------------------- */
/*                                  Deleting                                  */
/* -------------------------------------------------------------------------- */

export interface DeletionImpact {
  datasetId: string;
  name: string;
  analyses: number;
  cleanedCopies: number;
}

/** What "delete everything" would destroy, so the confirmation can say it. */
export async function deletionImpact(datasetId: string, userId: string): Promise<DeletionImpact> {
  const row = await requireOwned(datasetId, userId);
  const counts = await datasetsRepo.countDependents(datasetId, userId);
  return { datasetId, name: row.originalName, ...counts };
}

/**
 * Delete the file, keep the results.
 *
 * The bytes go and the row is marked, so nothing can read the file again. Every
 * analysis computed from it survives — a number already written into a chapter
 * must not disappear because its source file was tidied away.
 *
 * The object is removed before the row is marked. A row still pointing at
 * missing bytes surfaces as a clear read error; a row marked deleted whose
 * bytes are still on disk is an orphan nobody will ever look for.
 */
export async function deleteFileOnly(datasetId: string, userId: string): Promise<DeletionImpact> {
  const row = await requireOwned(datasetId, userId);
  const counts = await datasetsRepo.countDependents(datasetId, userId);

  await storageProvider()
    .delete(row.storageKey)
    .catch((error) => {
      logger.warn('dataset.objectDeleteFailed', { datasetId, error: String(error) });
    });

  await datasetsRepo.softDelete(datasetId, userId);

  logger.info('dataset.fileDeleted', { datasetId, analysesKept: counts.analyses });

  return { datasetId, name: row.originalName, ...counts };
}

/**
 * Delete everything: the file, its cleaned copies, and every analysis.
 *
 * Irreversible, so the caller must pass `confirmed`. That flag exists to make
 * the confirmation a decision the API layer has to represent explicitly rather
 * than a checkbox the interface might forget to require.
 */
export async function deleteEverything(
  datasetId: string,
  userId: string,
  confirmed: boolean,
): Promise<DeletionImpact> {
  if (!confirmed) {
    throw new AppError(
      'VALIDATION',
      'Deleting everything must be confirmed.',
      'يجب تأكيد حذف كل شيء.',
    );
  }

  // Includes soft-deleted rows: a user who deleted the file and now wants the
  // analyses gone too must still be able to finish the job.
  const row = await datasetsRepo.findOwnedIncludingDeleted(datasetId, userId);
  if (!row) {
    throw new AppError('NOT_FOUND', 'That file was not found.', 'لم يُعثر على الملف.');
  }

  const counts = await datasetsRepo.countDependents(datasetId, userId);
  const children = await datasetsRepo.listChildren(datasetId, userId);

  /*
   * Objects first, then the row. The database cascade removes the child rows
   * and the analyses, so their storage keys have to be collected while they
   * still exist — after the delete there is nothing left to tell us what to
   * remove from disk.
   *
   * Each dataset has its own folder, so a child's folder has to be removed as
   * well as its object. Deleting the file alone leaves an empty directory
   * behind, which is harmless until there are thousands of them.
   */
  const provider = storageProvider();
  const isLocal = provider instanceof LocalStorageProvider;

  for (const child of children) {
    await provider.delete(child.storageKey).catch(() => undefined);
    if (isLocal) {
      await (provider as LocalStorageProvider)
        .deletePrefix(`datasets/${userId}/${child.id}/`)
        .catch(() => undefined);
    }
  }

  await provider.delete(row.storageKey).catch(() => undefined);

  /*
   * A local provider can remove the whole dataset folder, which also sweeps up
   * anything a partially-failed earlier write may have left behind.
   */
  if (isLocal) {
    await (provider as LocalStorageProvider)
      .deletePrefix(`datasets/${userId}/${datasetId}/`)
      .catch(() => undefined);
  }

  await datasetsRepo.hardDelete(datasetId, userId);

  logger.info('dataset.purged', {
    datasetId,
    analysesDeleted: counts.analyses,
    copiesDeleted: counts.cleanedCopies,
  });

  return { datasetId, name: row.originalName, ...counts };
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

async function parse(file: { name: string; bytes: ArrayBuffer }): Promise<ParsedDataset> {
  try {
    return await readUpload(file);
  } catch (error) {
    if (error instanceof DataParseError) {
      throw new AppError('VALIDATION', error.reasonKey, error.reasonKey, {
        reasonKey: error.reasonKey,
        params: error.params,
      });
    }
    throw error;
  }
}

function noticesFor(parsed: ParsedDataset): { key: string; params?: Record<string, string | number> }[] {
  const notices: { key: string; params?: Record<string, string | number> }[] = [];

  if (parsed.truncatedTo) {
    notices.push({ key: 'analysis.notice.truncated', params: { rows: parsed.truncatedTo } });
  }
  if (parsed.skippedRows > 0) {
    notices.push({ key: 'analysis.notice.skippedRows', params: { rows: parsed.skippedRows } });
  }
  if (parsed.rows.length > INTERACTIVE_ROW_LIMIT) {
    notices.push({
      key: 'analysis.notice.interactiveWindow',
      params: { rows: INTERACTIVE_ROW_LIMIT, total: parsed.rows.length },
    });
  }

  return notices;
}
