import { MAX_FILE_BYTES } from '@/analysis';
import { AppError } from '@/server/http/errors';
import { ok, withApi } from '@/server/http/api';
import { inspectUpload } from '@/server/services/analysis.service';

/**
 * Inspects an uploaded dataset and returns what is in it.
 *
 * Reads nothing from the database and calls no AI provider: profiling is
 * arithmetic, so it costs the user nothing from their AI quota. The rate limit
 * is here because parsing a twelve-megabyte workbook is real work, not because
 * the operation is sensitive.
 */
export const POST = withApi(
  { rateLimit: { max: 20, windowSeconds: 300, key: 'analysis.profile' } },
  async ({ request }) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');

    if (!(file instanceof File)) {
      throw new AppError('VALIDATION', 'Attach a data file.', 'أرفق ملف بيانات.');
    }

    if (file.size > MAX_FILE_BYTES) {
      throw new AppError(
        'VALIDATION',
        'The file is larger than the upload limit.',
        'حجم الملف أكبر من الحد المسموح به.',
      );
    }

    const result = await inspectUpload({ name: file.name, bytes: await file.arrayBuffer() });
    return ok(result);
  },
);
