import { ok, withApi } from '@/server/http/api';
import { compareTitles } from '@/server/services/ai.service';
import { compareTitlesSchema, type CompareTitlesInput } from '@/server/validation/ai';

export const maxDuration = 60;

export const POST = withApi<CompareTitlesInput>(
  {
    schema: compareTitlesSchema,
    rateLimit: { key: 'ai-title-compare', max: 20, windowSeconds: 300 },
  },
  async ({ user, body }) => {
    const comparison = await compareTitles(user.id, body.projectId, body.titles);
    return ok(comparison);
  },
);
