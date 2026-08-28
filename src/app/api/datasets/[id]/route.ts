import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { AppError } from '@/server/http/errors';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import * as runsRepo from '@/server/repositories/analysis-runs.repository';
import {
  deleteEverything,
  deleteFileOnly,
  deletionImpact,
  requireOwned,
} from '@/server/services/dataset.service';

type Params = { id: string };

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  const dataset = await requireOwned(params.id, user.id);

  return ok({
    dataset,
    cleanedCopies: await datasetsRepo.listChildren(params.id, user.id),
    analyses: await runsRepo.listByDataset(params.id, user.id),
    impact: await deletionImpact(params.id, user.id),
  });
});

const deleteQuery = z.object({ mode: z.enum(['file', 'all']).default('file'), confirm: z.string().optional() });

/**
 * Two deletions, deliberately distinguished.
 *
 * `mode=file` removes the bytes and keeps every analysis computed from them: a
 * number already written into a chapter must not vanish because its source file
 * was tidied away.
 *
 * `mode=all` destroys the file, its cleaned copies, and every result. It is
 * irreversible, so it requires `confirm=yes` in the query — the confirmation is
 * part of the request rather than a checkbox the interface might forget.
 */
export const DELETE = withApi<undefined, Params>({}, async ({ request, user, params }) => {
  const url = new URL(request.url);
  const query = deleteQuery.parse({
    mode: url.searchParams.get('mode') ?? 'file',
    confirm: url.searchParams.get('confirm') ?? undefined,
  });

  if (query.mode === 'all') {
    if (query.confirm !== 'yes') {
      throw new AppError(
        'VALIDATION',
        'Deleting everything must be confirmed with confirm=yes.',
        'يجب تأكيد حذف كل شيء عبر confirm=yes.',
      );
    }
    return ok({ mode: 'all', ...(await deleteEverything(params.id, user.id, true)) });
  }

  return ok({ mode: 'file', ...(await deleteFileOnly(params.id, user.id)) });
});
