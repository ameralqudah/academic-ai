'use client';

import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  Download,
  Loader2,
  MinusCircle,
  Pause,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

/**
 * What a running task looks like to the person waiting for it.
 *
 * A percentage would be easier and would tell them nothing. A thesis workflow
 * runs for minutes across a dozen steps, and "43%" cannot distinguish steady
 * progress from a hang — where "Searching the literature ✓ / Writing chapter
 * three ●" can. The steps are the honest unit of progress because they are the
 * unit the work is actually divided into.
 *
 * **Failures stay visible.** A failed step keeps its place in the list with its
 * reason, and the steps that depended on it are shown as blocked rather than
 * vanishing. A researcher whose export never appeared needs to see why, not to
 * find a shorter list than they remember.
 */

export interface TaskStepView {
  id: string;
  ordinal: number;
  capability: string;
  label: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'BLOCKED';
  attempts: number;
  errorReasonKey: string | null;
  dynamic: boolean;
  durationMs: number | null;
  artifactIds: string[];
  output: Record<string, unknown> | null;
}

export interface TaskView {
  id: string;
  status:
    | 'QUEUED'
    | 'PLANNING'
    | 'RUNNING'
    | 'PAUSED'
    | 'WAITING_FOR_INPUT'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
  request: string;
  pendingQuestion: string | null;
  pauseReasonKey: string | null;
  errorReasonKey: string | null;
  context: Record<string, unknown>;
}

export function TaskProgress({
  taskId,
  onFinished,
}: {
  taskId: string;
  onFinished?: (task: TaskView, steps: TaskStepView[]) => void;
}) {
  const t = useTranslations('task');

  const [task, setTask] = useState<TaskView | null>(null);
  const [steps, setSteps] = useState<TaskStepView[]>([]);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Whether live updates are arriving, shown as a quiet indicator. */
  const [streaming, setStreaming] = useState(false);

  /* Guards against the finish callback firing twice on a late poll. */
  const finished = useRef(false);

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;

    /**
     * Applies a payload from either transport.
     *
     * Shared so the stream and the poll cannot drift: two copies of "what to do
     * with an update" is two places for the finish callback to be forgotten.
     */
    function apply(data: { task: TaskView; steps: TaskStepView[] }) {
      if (!active) return;

      setTask(data.task);
      setSteps(data.steps);

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(data.task.status) && !finished.current) {
        finished.current = true;
        onFinished?.(data.task, data.steps);
      }
    }

    /**
     * Polling, kept as the fallback it always was.
     *
     * A proxy that buffers, a network that drops idle connections, a browser
     * without EventSource — any of these breaks the stream, and none of them
     * should leave the researcher watching a frozen panel. Slower is not
     * broken.
     */
    async function poll() {
      for (let attempt = 0; attempt < 900 && active; attempt += 1) {
        try {
          const response = await fetch(`/api/tasks/${taskId}`);
          const json = await response.json();

          if (!json.ok) break;

          const data = json.data as { task: TaskView; steps: TaskStepView[] };
          apply(data);

          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(data.task.status)) return;

          /*
           * Polling stops while the task waits for an answer or sits at a
           * limit. Nothing will change until the person acts, and continuing
           * every two seconds for an hour is load nobody benefits from.
           */
          if (data.task.status === 'WAITING_FOR_INPUT' || data.task.status === 'PAUSED') return;
        } catch {
          /* A dropped poll is not a failure; the next one catches up. */
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    /**
     * The stream, which is the normal path.
     *
     * `EventSource` reconnects on its own when a connection drops, so a brief
     * network interruption costs nothing visible. What it cannot recover from
     * is a server that refuses the stream at all, and that is what the error
     * handler falls back from.
     */
    function connect() {
      try {
        source = new EventSource(`/api/tasks/${taskId}/stream`);

        source.addEventListener('update', (event) => {
          try {
            apply(JSON.parse((event as MessageEvent).data));
            setStreaming(true);
          } catch {
            /* A malformed frame is skipped; the next one carries the state. */
          }
        });

        source.addEventListener('done', () => {
          source?.close();
          source = null;
        });

        /*
         * The stream ending at its own time limit. Reconnecting is deliberate
         * rather than left to EventSource, because the server closed cleanly
         * and the browser would otherwise wait out its backoff.
         */
        source.addEventListener('reconnect', () => {
          source?.close();
          source = null;
          if (active) connect();
        });

        source.onerror = () => {
          /*
           * EventSource retries by itself while the connection can be made at
           * all. Falling back to polling only when it has given up entirely
           * avoids running both transports at once.
           */
          if (source?.readyState === EventSource.CLOSED) {
            source = null;
            setStreaming(false);
            void poll();
          }
        };
      } catch {
        /* No EventSource in this environment. */
        setStreaming(false);
        void poll();
      }
    }

    connect();

    return () => {
      active = false;
      source?.close();
    };
  }, [taskId, onFinished]);

  async function submitAnswer() {
    if (!answer.trim()) return;

    setSending(true);
    setError(null);

    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'answer', answer: answer.trim() }),
      });

      const json = await response.json();

      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? t('error.answerFailed'));
        return;
      }

      setAnswer('');
      finished.current = false;

      /* The poll loop restarts, because the task is running again. */
      setTask((current) => (current ? { ...current, status: 'RUNNING', pendingQuestion: null } : current));
    } catch {
      setError(t('error.answerFailed'));
    } finally {
      setSending(false);
    }
  }

  async function resume() {
    setSending(true);

    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume', additionalSteps: 20, additionalModelCalls: 40 }),
      });

      finished.current = false;
      setTask((current) =>
        current ? { ...current, status: 'RUNNING', pauseReasonKey: null, errorReasonKey: null } : current,
      );
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    setTask((current) => (current ? { ...current, status: 'CANCELLED' } : current));
  }

  if (!task) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface p-3 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('starting')}
      </div>
    );
  }

  const completed = steps.filter((step) => step.status === 'COMPLETED').length;
  const artifacts = steps.flatMap((step) => step.artifactIds);
  const running = ['QUEUED', 'PLANNING', 'RUNNING'].includes(task.status);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{t(`status.${task.status}`)}</span>

        {steps.length > 0 && (
          <span className="text-xs text-muted">
            {t('stepCount', { done: completed, total: steps.length })}
          </span>
        )}

        {/*
          A quiet mark that updates are live. Not a label: a researcher does
          not need to know which transport is carrying their progress, only
          that it is moving.
        */}
        {running && streaming && (
          <span className="size-1.5 rounded-full bg-accent" aria-hidden />
        )}

        {running && (
          <button
            type="button"
            onClick={() => void cancel()}
            className="ms-auto text-xs text-muted hover:text-danger"
          >
            {t('cancel')}
          </button>
        )}
      </div>

      {/*
        Planning has no steps to show yet, and a blank panel for twenty seconds
        reads as a hang.
      */}
      {task.status === 'PLANNING' && (
        <p className="text-xs text-muted">{t('planning')}</p>
      )}

      {/*
        A task that failed before producing any steps.

        Planning needs a model call, so an exhausted quota or a missing key
        stops the task with nothing to show — and the panel rendered one word,
        "Failed", with no steps and no reason. A failure the researcher cannot
        act on is worse than no feature.
      */}
      {task.status === 'FAILED' && steps.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-subtle p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <span className="text-sm text-ink">
            {task.errorReasonKey && task.errorReasonKey !== 'task.error.crashed'
              ? t(`step.reason.${task.errorReasonKey.split('.').pop()}`)
              : /*
                 * The provider's own message when the cause was not recognised.
                 * "Stopped by an unexpected error" is true and useless — it
                 * tells the researcher what they already know.
                 */
                (taskFailureDetail(task) ?? t('failedBeforePlanning'))}
          </span>
        </div>
      )}

      {steps.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      )}

      {/*
        The question, when one is needed. Asked inline rather than in a dialog:
        the task is paused and the context is right here.
      */}
      {task.status === 'WAITING_FOR_INPUT' && task.pendingQuestion && (
        <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-subtle p-3">
          <p className="text-sm text-ink">{task.pendingQuestion}</p>

          <div className="flex gap-2">
            <input
              value={answer}
              onChange={(change) => setAnswer(change.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitAnswer();
              }}
              disabled={sending}
              placeholder={t('answerPlaceholder')}
              className="min-w-0 flex-1 rounded-lg border border-line bg-ground px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void submitAnswer()}
              disabled={sending || !answer.trim()}
              className="rounded-lg border border-accent px-3 py-1.5 text-sm text-accent hover:bg-subtle disabled:opacity-50"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : t('send')}
            </button>
          </div>
        </div>
      )}

      {/*
        A pause at a limit, which is not a failure: the work done is kept and
        the person decides whether to continue.
      */}
      {/*
        A failed task offers a retry.

        A step that failed on a quota or a provider outage will succeed on the
        next attempt, and the work already done is still there — making the
        researcher start over would discard steps that completed. The button
        continues from the failed step rather than replanning.
      */}
      {task.status === 'FAILED' && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-subtle p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          <span className="flex-1 text-sm text-ink">
            {task.errorReasonKey
              ? t(`step.reason.${task.errorReasonKey.split('.').pop()}`)
              : t('failedBeforePlanning')}
          </span>
          <button
            type="button"
            onClick={() => void resume()}
            disabled={sending}
            className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-accent hover:border-accent disabled:opacity-50"
          >
            {t('retry')}
          </button>
        </div>
      )}

      {task.status === 'PAUSED' && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle p-3">
          <Pause className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="flex-1 text-sm text-ink">
            {task.pauseReasonKey ? t(`paused.${task.pauseReasonKey.split('.').pop()}`) : t('paused.generic')}
          </span>
          <button
            type="button"
            onClick={() => void resume()}
            disabled={sending}
            className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-accent hover:border-accent disabled:opacity-50"
          >
            {t('continue')}
          </button>
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <span className="text-xs font-medium text-muted">{t('files')}</span>

          {steps
            .filter((step) => step.artifactIds.length > 0)
            .map((step) =>
              step.artifactIds.map((artifactId) => (
                <a
                  key={artifactId}
                  href={`/api/artifacts/${artifactId}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-accent hover:bg-subtle"
                >
                  <Download className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">
                    {(step.output?.filename as string) ?? step.label}
                  </span>
                  {/*
                    The validation verdict beside the file. A document that
                    failed its quality check should say so where the person
                    downloads it, not somewhere they have to go looking.
                  */}
                  {step.output?.validationStatus === 'fail' && (
                    <AlertTriangle className="size-3 shrink-0 text-danger" aria-hidden />
                  )}
                </a>
              )),
            )}
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-danger">
          <AlertTriangle className="size-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
/**
 * The message a failed task recorded before any step existed.
 *
 * Planning needs a model call, so a task can fail with nothing to show. The
 * detail is kept in the task context rather than a dedicated column — a
 * migration for one diagnostic string was not worth the deploy risk.
 */
function taskFailureDetail(task: TaskView): string | null {
  const detail = (task.context as { failureDetail?: string } | undefined)?.failureDetail;
  if (!detail) return null;

  const firstLine = detail.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine.slice(0, 160) : null;
}

/**
 * The message a failed step recorded, when it left one.
 *
 * Truncated, because a provider error can run to several lines of stack and the
 * step list is not the place for it — the first sentence is what identifies the
 * problem.
 */
function failureMessage(step: TaskStepView): string | null {
  const observation = (step.output as { observation?: { errors?: { message?: string }[] } } | null)
    ?.observation;

  const message = observation?.errors?.[0]?.message;
  if (!message) return null;

  const firstLine = message.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine.slice(0, 140) : null;
}
function StepRow({ step }: { step: TaskStepView }) {
  const t = useTranslations('task');

  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0">
        {step.status === 'COMPLETED' && <Check className="size-3.5 text-accent" aria-hidden />}
        {step.status === 'RUNNING' && (
          <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
        )}
        {step.status === 'PENDING' && <CircleDashed className="size-3.5 text-muted" aria-hidden />}
        {step.status === 'FAILED' && <X className="size-3.5 text-danger" aria-hidden />}
        {(step.status === 'BLOCKED' || step.status === 'SKIPPED') && (
          <MinusCircle className="size-3.5 text-muted" aria-hidden />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'truncate',
            step.status === 'COMPLETED' && 'text-ink-soft',
            step.status === 'RUNNING' && 'text-ink',
            step.status === 'PENDING' && 'text-muted',
            step.status === 'FAILED' && 'text-danger',
            (step.status === 'BLOCKED' || step.status === 'SKIPPED') && 'text-muted line-through',
          )}
        >
          {step.label}
        </span>

        {/*
          A blocked step says why it will not run. Without this it looks
          skipped, and a researcher wonders whether they asked for it.
        */}
        {step.status === 'BLOCKED' && (
          <span className="text-[11px] text-muted">{t('step.blocked')}</span>
        )}

        {step.status === 'FAILED' && (
          <span className="text-[11px] text-danger">
            {/*
              The reason, when one was recognised.

              "failed after 1 attempt" could mean a quota, an outage, or a bug,
              and gives the researcher nothing to act on. An exhausted allowance
              is something they can fix; a network blip is worth retrying; a
              crash is worth reporting. Saying which turns a dead end into a
              next step.
            */}
            {step.errorReasonKey && step.errorReasonKey !== 'task.error.stepThrew'
              ? t(`step.reason.${step.errorReasonKey.split('.').pop()}`)
              : (failureMessage(step) ?? t('step.failed', { attempts: step.attempts }))}
          </span>
        )}

        {/*
          Steps the planner added while running are marked, so the plan's
          history stays legible — a list that grew without explanation reads as
          the system doing something unasked.
        */}
        {step.dynamic && step.status !== 'PENDING' && (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <ChevronRight className="size-2.5" aria-hidden />
            {t('step.added')}
          </span>
        )}
      </span>

      {step.durationMs !== null && step.status === 'COMPLETED' && (
        <span className="shrink-0 text-[11px] text-muted">
          {step.durationMs < 1000
            ? `${step.durationMs}ms`
            : `${Math.round(step.durationMs / 1000)}s`}
        </span>
      )}
    </li>
  );
}

