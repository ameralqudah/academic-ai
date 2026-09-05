import { z } from 'zod';

import { logger } from '@/lib/logger';
import { routeRequest } from '@/server/agent/router';
import { namedFormat, resolveReference, type Resolution } from '@/server/agent/continuity';
import { buildContextPrompt } from '@/server/context/manager';
import { ok, withApi } from '@/server/http/api';
import { answerGeneralQuestion } from '@/server/services/ai.service';
import { startTask } from '@/server/services/task.service';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as artifactsRepo from '@/server/repositories/artifacts.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';

/**
 * One place a message goes.
 *
 * Every message used to go to one of four endpoints depending on a dropdown,
 * which made the researcher the router: they had to know that "analyse my
 * data" belonged in one mode and "explain Cronbach's alpha" in another, before
 * knowing what the product does. Picking wrong gave a conversational answer to
 * a request that needed a file, which reads as the product being incapable.
 *
 * This endpoint decides instead. It does not replace the old routes — they
 * remain and call the same capabilities — because switching every caller in
 * one change is how a working system stops working.
 *
 * **The decision is deliberately coarse: answer, or start a task.** Which tools
 * a task uses is the planner's judgement, made with the whole request and the
 * project context. A router that also chose tools would be a second planner
 * disagreeing with the first.
 */
/*
 * Phrases in which a model admits it cannot do what was asked.
 *
 * Matched literally, and that is the right tool here: these are the model's own
 * words in a response we just received, not a user's request in an unknown
 * dialect. The semantic work — understanding what the researcher meant — was
 * done by the classifier before this point.
 *
 * Deliberately narrow. A false escalation turns an answered question into a
 * multi-step task, which is slower and stranger than the answer would have
 * been, so only the plainest admissions count.
 */
const CANNOT_ANSWER = [
  /\bI (?:don't|do not) have (?:access to|the ability|real[- ]time)/i,
  /\bI (?:cannot|can't|am unable to) (?:browse|search|access|read|open|generate|create) /i,
  /\bmy (?:training data|knowledge) (?:only goes|has a cutoff|ends)/i,
  /\bI would need (?:to search|access to|the file)/i,
  /لا أستطيع (?:الوصول|البحث|قراءة|إنشاء|إنتاج)/,
  /ليس لدي (?:إمكانية|القدرة|وصول)/,
  /لا يمكنني (?:الوصول|البحث|قراءة|إنشاء|تصدير|إرسال)/,
  /معلوماتي (?:محدودة|تتوقف|قديمة)/,
];

/**
 * Whether an answer admits it could not do the work.
 *
 * Checked against the first part of the response: a model that refuses does so
 * near the start, and a mention of limitations three paragraphs into a good
 * answer is a caveat rather than a refusal.
 */
function detectEscalation(content: string, _locale: 'ar' | 'en'): string | null {
  const opening = content.slice(0, 500);

  for (const pattern of CANNOT_ANSWER) {
    const match = opening.match(pattern);
    if (match) return match[0].slice(0, 60);
  }

  return null;
}

const schema = z.object({
  message: z.string().min(1).max(8000),
  locale: z.enum(['ar', 'en']).default('en'),
  conversationId: z.string().optional(),
  projectId: z.string().optional(),
  datasetId: z.string().optional(),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 60, windowSeconds: 300, key: 'chat.send' } },
  async ({ user, body }) => {
    /*
     * The dataset profile, when one is attached.
     *
     * Column names and types only — the classifier needs to know whether the
     * message refers to real variables, and the rows are neither useful for
     * that nor safe to put in a prompt.
     */
    const dataset = body.datasetId
      ? await datasetsRepo.findOwned(body.datasetId, user.id)
      : undefined;

    /*
     * Recent turns, for a message that refers to one. "Shorten it" means
     * nothing alone, and a router that could not see the previous turn would
     * treat every follow-up as a fresh request.
     */
    const history = body.conversationId
      ? (await conversationsRepo.listMessages(body.conversationId, 6))
          .filter((message) => typeof message.content === 'string')
          .map((message) => ({
            role: message.role === 'USER' ? ('user' as const) : ('assistant' as const),
            content: message.content,
          }))
      : [];

    /*
     * Earlier work of any kind: a file produced, a task run, a dataset
     * uploaded. Checked in parallel with the history because all three are
     * cheap reads and any one of them makes a reference resolvable.
     */
    const [recentArtifacts, recentTasks] = await Promise.all([
      artifactsRepo.listLatest(user.id, 3).catch(() => []),
      tasksRepo.listForUser(user.id, 3).catch(() => []),
    ]);

    const hasEarlierWork =
      recentArtifacts.length > 0 || recentTasks.length > 0 || Boolean(dataset);

    const decision = await routeRequest({
      message: body.message,
      locale: body.locale,
      hasDataset: Boolean(dataset),
      profile: (dataset?.profile as never) ?? null,
      /*
       * Whether a reference could point at anything.
       *
       * Message count is the wrong test. A task writes its output to a file
       * and its progress to a panel — not to the conversation — so a researcher
       * who received a Word document and then wrote "حوّله PDF" had an empty
       * history and their reference was ignored. What matters is whether work
       * exists, and files and tasks are where work lives.
       */
      hasPriorWork: history.length > 0 || hasEarlierWork,
      history,
      userId: user.id,
    });

    /*
     * A reference resolved before the task starts.
     *
     * "حوّله PDF" is a task with a subject, and the subject is not in the
     * sentence. Starting the task without it would have the planner search for
     * a paper that already exists — producing a second one, which is the
     * failure a researcher notices when they open the file.
     */
    let resolved: Resolution | null = null;

    if (decision.referencesPrevious) {
      resolved = await resolveReference({
        userId: user.id,
        kind: decision.referencesPrevious,
        message: body.message,
        locale: body.locale,
        conversationId: body.conversationId ?? null,
        projectId: body.projectId ?? null,
      });

      /*
       * Several things could be meant. Asked rather than guessed: picking the
       * most recent would be right often enough to be dangerous — it would
       * work until the day it rewrote the wrong chapter, and by then nobody
       * would be checking.
       */
      if (resolved.status === 'ambiguous') {
        return ok({
          path: 'fast' as const,
          content: resolved.question,
          needsChoice: resolved.candidates.map((candidate) => ({
            id: candidate.id,
            kind: candidate.kind,
            label: candidate.label,
          })),
        });
      }

      /* Nothing to refer to. The question says what is missing. */
      if (resolved.status === 'none') {
        return ok({ path: 'fast' as const, content: resolved.question });
      }
    }

    /* The format the request named, if any — read once rather than twice. */
    const format = namedFormat(body.message);

    if (decision.path === 'agent') {
      /*
       * The task carries the routing hints in its context, where the planner
       * reads them as suggestions. They are hints and not instructions: this
       * saw one message, the planner sees the request and the project.
       */
      /*
       * The resolved subject travels in the task context, where the planner
       * and the handlers read it. Passing the id rather than the content keeps
       * the task small: a handler that needs the text fetches it, and one that
       * only needs to know a file exists does not pay for its bytes.
       */
      const task = await startTask({
        userId: user.id,
        request: body.message,
        locale: body.locale,
        projectId: body.projectId ?? null,
        conversationId: body.conversationId ?? null,
        datasetId:
          resolved?.status === 'resolved' && resolved.candidate.datasetId
            ? resolved.candidate.datasetId
            : (body.datasetId ?? null),
        ...(resolved?.status === 'resolved'
          ? {
              references: {
                kind: resolved.candidate.kind,
                id: resolved.candidate.id,
                ...(resolved.candidate.taskId ? { taskId: resolved.candidate.taskId } : {}),
                ...(format ? { targetFormat: format } : {}),
              },
            }
          : {}),
      });

      logger.info('chat.delegatedToAgent', {
        resolvedTo: resolved?.status === 'resolved' ? resolved.candidate.id : null,
        taskId: task.id,
        intent: decision.intent.intent,
        reason: decision.reason,
      });

      return ok(
        {
          path: 'agent' as const,
          task: { id: task.id, status: task.status },
          /* Shown while the plan is being built, so the wait is not silent. */
          restatement: decision.intent.restatement,
        },
        { status: 202 },
      );
    }

    /*
     * The fast path, which reads the same context the agent would.
     *
     * That shared context is what makes "make it shorter" work here at all: the
     * answer needs to know what "it" was, and a fast path with its own,
     * thinner notion of context would answer confidently about the wrong
     * thing.
     */
    let contextPrompt = '';

    try {
      const built = await buildContextPrompt({
        purpose: 'answer',
        request: body.message,
        userId: user.id,
        conversationId: body.conversationId ?? null,
        projectId: body.projectId ?? null,
        datasetId: body.datasetId ?? null,
        locale: body.locale,
      });

      contextPrompt = built.prompt;
    } catch (error) {
      /*
       * A failed context build must not fail the answer. The assistant can
       * reply without remembering; it cannot reply at all if this throws.
       */
      logger.warn('chat.contextFailed', { error: String(error).slice(0, 200) });
    }

    const answer = await answerGeneralQuestion({
      userId: user.id,
      message: body.message,
      locale: body.locale,
      projectId: body.projectId ?? null,
      history: [],
      ...(contextPrompt
        ? {
            context: {
              conversationId: body.conversationId ?? null,
              datasetId: body.datasetId ?? null,
            },
          }
        : {}),
    });

    /*
     * The fast path noticing it was the wrong path.
     *
     * A model asked something it cannot answer says so — that it lacks current
     * information, that it cannot read the file, that it cannot produce a
     * document. That admission is the signal to escalate, and it is more
     * reliable than the routing guess that preceded it because the model has
     * now actually attempted the work.
     *
     * Escalating costs a wasted call. Not escalating leaves the researcher
     * with a refusal where a capable system would have searched, which is the
     * failure worth paying a call to avoid.
     */
    const escalation = detectEscalation(answer.content, body.locale);

    if (escalation) {
      const task = await startTask({
        userId: user.id,
        request: body.message,
        locale: body.locale,
        projectId: body.projectId ?? null,
        conversationId: body.conversationId ?? null,
        datasetId: body.datasetId ?? null,
      });

      logger.info('chat.escalated', {
        taskId: task.id,
        intent: decision.intent.intent,
        signal: escalation,
      });

      return ok(
        {
          path: 'agent' as const,
          task: { id: task.id, status: task.status },
          restatement: decision.intent.restatement,
          /* Recorded so a wrong escalation can be traced from the response. */
          escalatedFrom: 'fast' as const,
        },
        { status: 202 },
      );
    }

    return ok({
      path: 'fast' as const,
      content: answer.content,
      /*
       * The routing decision travels with the answer.
       *
       * Not shown to the user — explaining routing is the mode dropdown by
       * another name — but the client needs it to decide whether to offer an
       * escalation, and a wrong decision has to be traceable from a response.
       */
      routing: {
        intent: decision.intent.intent,
        confidence: decision.confidence,
        suggestedCapabilities: decision.suggestedCapabilities,
      },
    });
  },
);

