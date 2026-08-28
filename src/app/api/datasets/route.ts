import { z } from 'zod';

import { MAX_FILE_BYTES } from '@/analysis';
import { AppError } from '@/server/http/errors';
import { ok, withApi } from '@/server/http/api';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import { saveUpload } from '@/server/services/dataset.service';

/**
 * Uploading and listing stored datasets.
 *
 * The upload rate limit is tighter than the old stateless `/api/analysis/profile`
 * route, because this one keeps what it receives: parsing a spreadsheet costs
 * CPU, storing it costs disk, and disk does not free itself when the request
 * ends.
 *
 * No AI provider is touched here, so nothing is charged against the user's
 * quota — profiling a file is arithmetic.
 */
export const POST = withApi(
  { rateLimit: { max: 10, windowSeconds: 300, key: 'datasets.upload' } },
  async ({ request, user }) => {
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

    const projectId = form?.get('projectId');
    const conversationId = form?.get('conversationId');

    const saved = await saveUpload({
      userId: user.id,
      file: { name: file.name, bytes: await file.arrayBuffer() },
      projectId: typeof projectId === 'string' && projectId ? projectId : null,
      conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
    });

    return ok(saved, { status: 201 });
  },
);

const listQuery = z.object({ projectId: z.string().optional() });

export const GET = withApi({}, async ({ request, user }) => {
  const url = new URL(request.url);
  const query = listQuery.parse({ projectId: url.searchParams.get('projectId') ?? undefined });

  const datasets = query.projectId
    ? await datasetsRepo.listByProject(query.projectId, user.id)
    : await datasetsRepo.listByUser(user.id);

  // The profile is large and the list only needs the summary, so it is dropped.
  return ok({
    datasets: datasets.map(({ profile, ...rest }) => {
      void profile;
      return rest;
    }),
    totalBytes: await datasetsRepo.totalBytesForUser(user.id),
  });
});
