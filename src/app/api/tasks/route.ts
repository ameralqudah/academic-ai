import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { startTask } from '@/server/services/task.service';

/**
 * Starts a task.
 *
 * Returns immediately with an id; planning and execution continue in the
 * background, because a thesis workflow takes longer than any request will
 * survive.
 */
const schema = z.object({
  request: z.string().min(5).max(4000),
  locale: z.enum(['ar', 'en']).default('en'),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  datasetId: z.string().optional(),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 10, windowSeconds: 900, key: 'task.start' } },
  async ({ user, body }) => {
    const task = await startTask({
      userId: user.id,
      request: body.request,
      locale: body.locale,
      projectId: body.projectId ?? null,
      conversationId: body.conversationId ?? null,
      datasetId: body.datasetId ?? null,
    });

    return ok({ task: { id: task.id, status: task.status } }, { status: 202 });
  },
);

export const GET = withApi({}, async ({ user }) =>
  ok({ tasks: await tasksRepo.listForUser(user.id) }),
);
