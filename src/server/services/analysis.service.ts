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
const PARSE_MESSAGES: Record<string, { en: string; ar: string }> = {
  'analysis.error.emptyFile': {
    en: 'The file is empty.',
    ar: 'الملف فارغ.',
  },
  'analysis.error.noColumns': {
    en: 'The first row must contain column names.',
    ar: 'الصف الأول يجب أن يحتوي على أسماء الأعمدة.',
  },
  'analysis.error.noRows': {
    en: 'The file has column names but no data rows.',
    ar: 'الملف يحتوي على أسماء الأعمدة فقط دون أي بيانات.',
  },
  'analysis.error.tooManyColumns': {
    en: 'This file has more columns than the analyser accepts.',
    ar: 'عدد الأعمدة في هذا الملف أكبر مما يقبله المحلِّل.',
  },
  'analysis.error.tooLarge': {
    en: 'The file is larger than the upload limit.',
    ar: 'حجم الملف أكبر من الحد المسموح به.',
  },
  'analysis.error.unsupportedType': {
    en: 'Upload a CSV or an Excel workbook (.xlsx).',
    ar: 'ارفع ملف CSV أو مصنّف Excel بصيغة ‎.xlsx‎.',
  },
  'analysis.error.notAWorkbook': {
    en: 'This file is named like a spreadsheet but is not one.',
    ar: 'امتداد الملف يشير إلى جدول بيانات لكن محتواه ليس كذلك.',
  },
  'analysis.error.unreadableWorkbook': {
    en: 'The workbook could not be opened. Re-save it as .xlsx and try again.',
    ar: 'تعذّر فتح المصنّف. احفظه من جديد بصيغة ‎.xlsx‎ ثم أعد المحاولة.',
  },
  'analysis.error.noSheets': {
    en: 'The workbook has no sheets with data.',
    ar: 'لا يحتوي المصنّف على أي ورقة فيها بيانات.',
  },
};

async function read(file: { name: string; bytes: ArrayBuffer }): Promise<Dataset> {
  try {
    return await readUpload(file);
  } catch (error) {
    if (error instanceof DataParseError) {
      const message = PARSE_MESSAGES[error.reasonKey] ?? {
        en: 'The file could not be read.',
        ar: 'تعذّرت قراءة الملف.',
      };
      throw new AppError('VALIDATION', message.en, message.ar, {
        reason: error.reasonKey,
        ...error.params,
      });
    }
    throw error;
  }
}

function cleanedName(original: string): string {
  const base = original.replace(/\.[^.]+$/, '');
  return `${base}-cleaned.csv`;
}
