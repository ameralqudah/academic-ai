import { ok, withApi } from '@/server/http/api';
import { generateTitles, listTitles } from '@/server/services/ai.service';
import { generateTitlesSchema, type GenerateTitlesInput } from '@/server/validation/ai';

export const maxDuration = 60;

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
