import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { withApi } from '@/server/http/api';
import { AppError } from '@/server/http/errors';
import { exportPlsToExcel, exportPlsToWord } from '@/server/services/pls-export.service';
import { getJob } from '@/server/services/pls.service';

type Params = { id: string };

const query = z.object({
  format: z.enum(['docx', 'xlsx']).default('docx'),
  locale: z.enum(['ar', 'en']).default('en'),
});

/**
 * Downloads a finished PLS report as Word or Excel.
 *
 * The translator is built here rather than inside the export service, because
 * resolving messages belongs to the request — it is the request that knows the
 * locale. The service receives a function and stays free of i18n plumbing,
 * which is also what lets it produce either language from one code path.
 */
export const GET = withApi<undefined, Params>(
  { rateLimit: { max: 30, windowSeconds: 300, key: 'pls.export' } },
  async ({ request, user, params }) => {
    const url = new URL(request.url);
    const options = query.parse({
      format: url.searchParams.get('format') ?? 'docx',
      locale: url.searchParams.get('locale') ?? 'en',
    });

    const job = await getJob(params.id, user.id);

    if (job.status !== 'COMPLETED' || !job.result?.report) {
      throw new AppError(
        'VALIDATION',
        'That analysis has not finished yet.',
        'لم ينتهِ هذا التحليل بعد.',
      );
    }

    /*
     * The root namespace, because report keys are fully qualified — they come
     * from the analysis layer, which has no notion of which namespace an
     * interface might put them under.
     */
    const messages = await getTranslations({ locale: options.locale });
    const translate = (key: string, values?: Record<string, string | number>) => {
      try {
        return messages(key, values);
      } catch {
        /*
         * A missing key becomes the key itself rather than an exception. One
         * untranslated string should not fail a download the researcher has
         * waited a minute for — and the key is visible, so it gets reported.
         */
        return key;
      }
    };

    const buffer =
      options.format === 'xlsx'
        ? await exportPlsToExcel({ report: job.result.report, translate, locale: options.locale })
        : await exportPlsToWord({ report: job.result.report, translate, locale: options.locale });

    const extension = options.format;
    const filename = `pls-report-${params.id.slice(0, 8)}.${extension}`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type':
          options.format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, no-store',
      },
    });
  },
);
