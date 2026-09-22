import * as tasksRepo from '@/server/repositories/tasks.repository';
import type { OutputReference } from '@/server/tasks/contracts';
import type { Reference } from '@/server/quality/sources';

import { isResearch, writtenWork } from './written-work';

/**
 * What a conversation's tasks have written, newest first.
 *
 * A task writes its paper to its own steps and its progress to a panel; the
 * conversation records the request and a one-line restatement. So a question
 * asked after the paper — "what are the dimensions of each variable?" — reached
 * the model with the restatement and nothing else, and the model asked which
 * variables. The paper was two lines up on the researcher's screen.
 *
 * Read from the steps, where the text is, rather than copied into the
 * conversation, where it would be read back into every call whether wanted or
 * not. Callers take what they need: the context builder trims it to a budget,
 * a writing step continues from it, the planner sees only its opening.
 */
export interface EarlierWork {
  taskId: string;
  outputId: string;
  capability: string;
  /** Whether it is a paper or review rather than a passing reply. */
  research: boolean;
  heading: string;
  text: string;
  references: Reference[];
  at: Date;
}

export async function earlierWorkIn(input: {
  userId: string;
  conversationId: string;
  /** The task asking, which is not earlier than itself. */
  excludeTaskId?: string | null;
  limit?: number;
}): Promise<EarlierWork[]> {
  const tasks = (await tasksRepo.listForUser(input.userId, 12)).filter(
    (task) =>
      task.conversationId === input.conversationId &&
      task.status === 'COMPLETED' &&
      task.id !== input.excludeTaskId,
  );

  const found: EarlierWork[] = [];

  for (const task of tasks) {
    const steps = await tasksRepo.stepsOf(task.id);
    const written = writtenWork(steps);
    if (!written) continue;

    const data = written.output.data as { text?: string; heading?: string } | null;
    const references: Reference[] = [];

    for (const step of steps) {
      const outputs = (step.output as { outputs?: OutputReference[] } | null)?.outputs ?? [];

      for (const output of outputs) {
        if (!output.type.startsWith('sources')) continue;
        const bundle = output.data as { references?: Reference[] } | null;
        if (Array.isArray(bundle?.references)) references.push(...bundle.references);
      }
    }

    found.push({
      taskId: task.id,
      outputId: written.output.id,
      capability: written.step.capability,
      research: isResearch(written.step.capability),
      heading: data?.heading ?? '',
      text: data?.text ?? '',
      references,
      at: written.at,
    });

    if (found.length >= (input.limit ?? 3)) break;
  }

  return found.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * The one piece of earlier work a new request most likely continues.
 *
 * The latest research if there is any, else the latest reply — the same
 * preference `meantByIt` applies to "it".
 */
export async function latestEarlierWork(
  input: Parameters<typeof earlierWorkIn>[0],
): Promise<EarlierWork | null> {
  const all = await earlierWorkIn({ ...input, limit: 5 });
  return all.find((work) => work.research) ?? all[0] ?? null;
}
