import { z } from 'zod';
import { ok, withApi } from '@/server/http/api';
import { generateTitles, listTitles, clearUnselectedTitles, deleteTitle } from '@/server/services/ai.service';
import { generateTitlesSchema, type GenerateTitlesInput } from '@/server/validation/ai';

export const maxDuration = 60;

/**
 * Removing a suggestion, or all the rejected ones.
 *
 * There was no delete at all — a researcher generating three batches of five
 * accumulated fifteen suggestions with no way to clear any, so the list grew
 * until the useful ones were buried under the discarded.
 */
const deleteQuery = z.object({
  projectId: z.string(),
  /** Omit to clear every unselected suggestion in the project. */
  candidateId: z.string().optional(),
});

export const DELETE = withApi({}, async ({ request, user }) => {
  const url = new URL(request.url);
  const query = deleteQuery.parse({
    projectId: url.searchParams.get('projectId') ?? '',
    candidateId: url.searchParams.get('candidateId') ?? undefined,
  });

  if (query.candidateId) {
    await deleteTitle(user.id, query.projectId, query.candidateId);
    return ok({ deleted: 1 });
  }

  const cleared = await clearUnselectedTitles(user.id, query.projectId);
  return ok({ deleted: cleared });
});

export const GET = withApi({}, async ({ user, request }) => {
  const projectId = new URL(request.url).searchParams.get('projectId') ?? '';
  const titles = await listTitles(user.id, projectId);
  return ok(titles);
});

export const POST = withApi<GenerateTitlesInput>(
  {
    schema: generateTitlesSchema,
    rateLimit: { key: 'ai-titles', max: 12, windowSeconds: 300 },
  },
  async ({ user, body }) => {
    const titles = await generateTitles(user.id, body.projectId, body.count);
    return ok(titles, { status: 201 });
  },
);
