import {
  applyCleaning,
  DataParseError,
  planCleaning,
  profileDataset,
  readUpload,
  reportToText,
  toCsv,
  type CleaningAction,
  type CleaningReport,
  type Dataset,
  type DatasetProfile,
} from '@/analysis';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/errors';
import { resolveReason } from '@/server/http/reasons';

/**
 * The application's view of the data layer.
 *
 * Its whole job is translation: a multipart upload becomes a `Dataset`, and a
 * `DataParseError` becomes an `AppError` carrying a message in both languages.
 * No statistics are computed here and none are computed in the route — they
 * live in `src/analysis`, where they can be tested without a request.
 */

export interface InspectionResult {
  profile: DatasetProfile;
  proposals: CleaningAction[];
  preview: {
    columns: string[];
    rows: (string | number | boolean | null)[][];
  };
  notices: { key: string; params?: Record<string, string | number> }[];
}

/** Rows shown back to the user. Enough to recognise the file, not enough to ship it twice. */
const PREVIEW_ROWS = 15;

export async function inspectUpload(file: { name: string; bytes: ArrayBuffer }): Promise<InspectionResult> {
  const dataset = await read(file);
  const profile = profileDataset(dataset);
  const proposals = planCleaning(profile);

  const notices: InspectionResult['notices'] = [];
  if (dataset.truncatedTo) {
    notices.push({ key: 'analysis.notice.truncated', params: { rows: dataset.truncatedTo } });
  }
  if (dataset.skippedRows > 0) {
    notices.push({ key: 'analysis.notice.skippedRows', params: { rows: dataset.skippedRows } });
  }

  logger.info('analysis.inspected', {
    rows: profile.rowCount,
    columns: profile.columnCount,
    issues: profile.issues.length,
  });

  return {
    profile,
    proposals,
    preview: {
      columns: dataset.columns,
      rows: dataset.rows.slice(0, PREVIEW_ROWS),
    },
    notices,
  };
}

export interface CleanResult {
  csv: string;
  report: CleaningReport;
  reportText: string;
  filename: string;
}

/**
 * Produces the cleaned copy.
 *
 * The upload is read again rather than cached between requests: the source of
 * truth is the researcher's file, and a server-side copy that could drift from
 * it is a liability, not a convenience. Re-reading costs milliseconds.
 */
export async function cleanUpload(
  file: { name: string; bytes: ArrayBuffer },
  actions: CleaningAction[],
  locale: 'ar' | 'en',
): Promise<CleanResult> {
  const dataset = await read(file);
  const profile = profileDataset(dataset);

  const allowed = new Set(planCleaning(profile).map((action) => action.kind));
  const requested = actions.filter((action) => allowed.has(action.kind));

  const { cleaned, report } = applyCleaning(dataset, profile, requested);

  return {
    csv: toCsv(cleaned),
    report,
    reportText: reportToText(profile, report, locale),
    filename: cleanedName(file.name),
  };
}

/**
 * Why a file could not be read, in both languages.
 *
 * These reach the user directly, before any translation layer runs, so they are
 * written as sentences a researcher can act on rather than as error codes. A
 * key with no entry still produces a usable message rather than a blank.
 */

async function read(file: { name: string; bytes: ArrayBuffer }): Promise<Dataset> {
  try {
    return await readUpload(file);
  } catch (error) {
    if (error instanceof DataParseError) {
      /*
       * Resolved from the message files rather than a table local to this
       * service. There were two copies of this mapping — a hand-written one
       * here and none at all in the newer dataset service, which passed the raw
       * key through and put `analysis.error.notAWorkbook` on a user's screen.
       * One source, read by both.
       */
      const message = resolveReason(error.reasonKey, error.params);

      throw new AppError('VALIDATION', message.en, message.ar, {
        reasonKey: error.reasonKey,
        params: error.params,
      });
    }
    throw error;
  }
}

function cleanedName(original: string): string {
  const base = original.replace(/\.[^.]+$/, '');
  return `${base}-cleaned.csv`;
}
