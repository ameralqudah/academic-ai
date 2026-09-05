import { ok, withApi } from '@/server/http/api';
import * as tasksRepo from '@/server/repositories/tasks.repository';

/**
 * Tasks that are still going.
 *
 * A researcher who reloads the page during a ten-minute research run had no way
 * to find it again: the panel lived in React state and the conversation held
 * nothing about it. The work continued on the server, invisibly, which is worse
 * than it having stopped — they would have started it again.
 *
 * Returns only what is unfinished. A completed task is reachable through the
 * conversation and its artifacts; listing it here would fill the response with
 * history the caller has to filter.
 */
const ACTIVE = ['QUEUED', 'PLANNING', 'RUNNING', 'REPLANNING', 'WAITING_FOR_INPUT', 'PAUSED'];

export const GET = withApi(
  { rateLimit: { max: 120, windowSeconds: 300, key: 'tasks.active' } },
  async ({ user }) => {
    const tasks = await tasksRepo.listForUser(user.id, 20);

    const active = tasks.filter((task) => ACTIVE.includes(task.status));

    /*
     * Step counts, not the steps themselves.
     *
     * This is called on every page load, and a researcher with three running
     * tasks would otherwise pull forty step rows to render three progress
     * lines. The panel fetches the detail for the one it displays.
     */
    const withProgress = await Promise.all(
      active.map(async (task) => {
        const steps = await tasksRepo.stepsOf(task.id);

        return {
          id: task.id,
          status: task.status,
          request: task.request,
          conversationId: task.conversationId,
          pendingQuestion: task.pendingQuestion,
          createdAt: task.createdAt,
          progress: {
            total: steps.length,
            completed: steps.filter((step) => step.status === 'COMPLETED').length,
            /* What it is doing now, so a reattached panel is not blank. */
            current: steps.find((step) => step.status === 'RUNNING')?.label ?? null,
          },
        };
      }),
    );

    return ok({ tasks: withProgress });
  },
);

