import { MAX_FILE_BYTES, type CleaningAction } from '@/analysis';
import { AppError } from '@/server/http/errors';
import { ok, withApi } from '@/server/http/api';
import { cleanUpload } from '@/server/services/analysis.service';

/**
 * Produces the cleaned copy of an uploaded dataset.
 *
 * Returns the cleaned file as text alongside the report of what changed, so the
 * browser can offer both as downloads. The original is never written anywhere
 * and never altered — the only thing this endpoint can do to the researcher's
 * file is read it.
 */
export const POST = withApi(
  { rateLimit: { max: 20, windowSeconds: 300, key: 'analysis.clean' } },
  async ({ request, user }) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    const rawActions = form?.get('actions');

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

    let actions: CleaningAction[] = [];
    if (typeof rawActions === 'string' && rawActions.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawActions);
        if (Array.isArray(parsed)) actions = parsed as CleaningAction[];
      } catch {
        throw new AppError(
          'VALIDATION',
          'The list of cleaning steps was malformed.',
          'قائمة خطوات التنظيف غير صالحة.',
        );
      }
    }

    const result = await cleanUpload(
      { name: file.name, bytes: await file.arrayBuffer() },
      actions,
      user.locale,
    );

    return ok(result);
  },
);
