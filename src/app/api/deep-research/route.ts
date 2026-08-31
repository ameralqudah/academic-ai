import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { startDeepResearch } from '@/server/services/deep-research.service';

/**
 * Starts a deep research run.
 *
 * Returns a job id immediately; the workflow takes minutes and reports progress
 * through the polling route. Rate-limited hard because one run costs fifteen
 * searches and several model calls.
 */
const schema = z.object({
  question: z.string().min(10).max(500),
  locale: z.enum(['ar', 'en']).default('en'),
  projectId: z.string().optional(),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 5, windowSeconds: 900, key: 'research.deep' } },
  async ({ user, body }) => {
    const job = await startDeepResearch({
      userId: user.id,
      question: body.question,
      locale: body.locale,
      projectId: body.projectId ?? null,
    });

    return ok({ job: { id: job.id, status: job.status, progress: 0 } }, { status: 202 });
  },
);
