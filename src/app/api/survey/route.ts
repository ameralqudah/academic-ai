import { ok, withApi } from '@/server/http/api';
import { generateSurvey } from '@/server/services/survey.service';
import { surveyRequestSchema } from '@/server/survey/generator';
import { z } from 'zod';

/**
 * Generates a questionnaire draft.
 *
 * Rate-limited tightly: each call is a large model completion, and the output
 * is something a researcher iterates on a few times rather than in a loop.
 */
const schema = surveyRequestSchema.extend({
  conversationId: z.string().optional(),
  projectId: z.string().optional(),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 15, windowSeconds: 600, key: 'survey.generate' } },
  async ({ user, body }) => {
    const { conversationId, projectId, ...request } = body;

    const survey = await generateSurvey({
      userId: user.id,
      request,
      conversationId: conversationId ?? null,
      projectId: projectId ?? null,
    });

    return ok({ survey });
  },
);
