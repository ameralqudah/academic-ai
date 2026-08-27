import { ok, withApi } from '@/server/http/api';
import { improveTitle } from '@/server/services/ai.service';
import { improveTitleSchema, type ImproveTitleInput } from '@/server/validation/ai';

export const maxDuration = 60;

export const POST = withApi<ImproveTitleInput>(
  {
    schema: improveTitleSchema,
    rateLimit: { key: 'ai-title-improve', max: 20, windowSeconds: 300 },
  },
  async ({ user, body }) => {
    const variants = await improveTitle(user.id, body.projectId, body.title);
    return ok(variants);
  },
);
