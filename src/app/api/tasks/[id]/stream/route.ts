import { auth } from '@/server/auth';
import { logger } from '@/lib/logger';
import * as tasksRepo from '@/server/repositories/tasks.repository';

/**
 * Live progress for one task.
 *
 * The panel polled every two seconds, which is a reasonable fallback and a poor
 * primary: a step that finishes just after a poll shows as running for two more
 * seconds, and a ten-minute research run costs three hundred requests to watch.
 *
 * **The database remains the source of truth.** This streams what is stored,
 * re-read on an interval — it does not receive events from the executor and
 * hold them in memory. That matters because the executor may be a different
 * process after a deploy, and a stream fed from memory would show a task that
 * had already moved on, or nothing at all.
 *
 * The polling endpoint is untouched. A browser that cannot hold an event
 * stream open — a proxy that buffers, a network that drops idle connections —
 * falls back to it and loses nothing but immediacy.
 */

/** How often the stored state is re-read. */
const TICK_MS = 1500;

/**
 * How long one connection lives.
 *
 * Ten minutes, then the client reconnects. Platforms terminate long-lived
 * responses at their own limits without warning, and a stream that ends on its
 * own terms can say so first — `EventSource` reconnects automatically, so the
 * researcher sees nothing.
 */
const MAX_MS = 10 * 60 * 1000;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();

  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = await context.params;
  const userId = session.user.id;

  /* Ownership checked once, before the stream opens. */
  const task = await tasksRepo.findOwned(id, userId);

  if (!task) {
    return new Response('Not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let lastSignature = '';

      const send = (event: string, data: unknown) => {
        if (closed) return;

        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* The client went away between the check and the write. */
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;

        closed = true;
        try {
          controller.close();
        } catch {
          /* Already closed by the runtime. */
        }
      };

      /*
       * The client disconnecting is the normal way this ends — a reload, a
       * closed tab, a navigation. Without this the interval keeps querying for
       * a reader that is gone.
       */
      request.signal.addEventListener('abort', close);

      const tick = async () => {
        if (closed) return;

        if (Date.now() - startedAt > MAX_MS) {
          send('reconnect', { reason: 'max-duration' });
          close();
          return;
        }

        try {
          const current = await tasksRepo.findOwned(id, userId);

          if (!current) {
            send('error', { reason: 'not-found' });
            close();
            return;
          }

          const steps = await tasksRepo.stepsOf(current.id);

          const payload = {
            task: {
              id: current.id,
              status: current.status,
              request: current.request,
              pendingQuestion: current.pendingQuestion,
              pauseReasonKey: current.pauseReasonKey,
              errorReasonKey: current.errorReasonKey,
              context: current.context,
            },
            steps: steps.map((step) => ({
              id: step.id,
              ordinal: step.ordinal,
              capability: step.capability,
              label: step.label,
              status: step.status,
              attempts: step.attempts,
              errorReasonKey: step.errorReasonKey,
              dynamic: step.dynamic,
              durationMs: step.durationMs,
              artifactIds: step.artifactIds,
              output: step.output,
            })),
          };

          /*
           * Only changes are sent.
           *
           * A ten-minute task spends most of its time in one step, and
           * re-sending an identical payload every second and a half would cost
           * bandwidth to tell the client nothing. The signature covers what the
           * panel renders, so a change the researcher can see is a change that
           * is sent.
           */
          const signature = JSON.stringify([
            current.status,
            current.pendingQuestion,
            steps.map((step) => [step.status, step.attempts, step.artifactIds.length]),
          ]);

          if (signature !== lastSignature) {
            lastSignature = signature;
            send('update', payload);
          }

          /* A settled task has nothing further to report. */
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) {
            send('done', { status: current.status });
            close();
          }
        } catch (error) {
          logger.warn('task.streamFailed', { taskId: id, error: String(error).slice(0, 200) });
          send('error', { reason: 'read-failed' });
          close();
        }
      };

      /* Sent immediately, so a reattaching panel is never blank while it waits. */
      await tick();

      const interval = setInterval(() => {
        if (closed) {
          clearInterval(interval);
          return;
        }

        void tick();
      }, TICK_MS);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      /*
       * Nginx buffers proxied responses by default, which holds an event
       * stream until it is large enough to flush — turning live progress into
       * one burst at the end, which is worse than polling.
       */
      'x-accel-buffering': 'no',
    },
  });
}

