import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { answerTask, cancelTask, getTask, resumeTask } from '@/server/services/task.service';

type Params = { id: string };

/**
 * The task and its steps.
 *
 * Polled while work runs. The steps are the progress display: a researcher
 * watching for three minutes needs to see which stage they are at, not a
 * percentage that could mean anything.
 */
export const GET = withApi<undefined, Params>(
  { rateLimit: { max: 300, windowSeconds: 300, key: 'task.poll' } },
  async ({ user, params }) => ok(await getTask(params.id, user.id)),
);

const actionSchema = z.object({
  action: z.enum(['answer', 'resume']),
  /** The answer, when the task was waiting for one. */
  answer: z.string().max(2000).optional(),
  /** Extra budget, when resuming from a limit. */
  additionalSteps: z.number().int().min(1).max(50).optional(),
  additionalModelCalls: z.number().int().min(1).max(200).optional(),
});

type ActionBody = z.infer<typeof actionSchema>;

export const POST = withApi<ActionBody, Params>(
  { schema: actionSchema },
  async ({ user, params, body }) => {
    if (body.action === 'answer') {
      await answerTask({ taskId: params.id, userId: user.id, answer: body.answer ?? '' });
    } else {
      await resumeTask({
        taskId: params.id,
        userId: user.id,
        additionalBudget: {
          ...(body.additionalSteps ? { maxSteps: body.additionalSteps } : {}),
          ...(body.additionalModelCalls ? { maxModelCalls: body.additionalModelCalls } : {}),
        },
      });
    }

    return ok(await getTask(params.id, user.id));
  },
);

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await cancelTask(params.id, user.id);
  return ok({ cancelled: true });
});
