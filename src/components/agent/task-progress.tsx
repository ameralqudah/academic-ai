'use client';

import {
  AlertTriangle,
  Check,
  Copy,
  ChevronRight,
  CircleDashed,
  Download,
  Loader2,
  MinusCircle,
  Pause,
  X,
  FileText,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useArtifactPanel } from '@/components/agent/artifact-panel';
import { deliverableText, findingKey, taskDisplays, type TaskDisplay } from '@/components/agent/task-result';
import { Markdown } from '@/components/chat/markdown';
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

/**
 * The panel, and under it what the task wrote.
 *
 * Two components so the text sits in the thread like any other answer rather
 * than inside the panel's border: the panel is the record of how the work was
 * done, and the text is the work.
 */
export function TaskProgress({
  taskId,
  onFinished,
  renderResult,
}: {
  taskId: string;
  onFinished?: (task: TaskView, steps: TaskStepView[]) => void;
  /**
   * Draws a computed table. Passed in, so the chat's own result views are used
   * and an analysis looks the same however it was asked for.
   */
  renderResult?: (display: TaskDisplay, index: number) => ReactNode;
}) {
  const [written, setWritten] = useState<string | null>(null);
  const [displays, setDisplays] = useState<TaskDisplay[]>([]);

  return (
    <div className="flex flex-col gap-4">
      <TaskPanel
        taskId={taskId}
        onFinished={onFinished}
        onWritten={setWritten}
        onDisplays={setDisplays}
      />
      {renderResult && displays.map((display, index) => renderResult(display, index))}
      {written && <WrittenResult text={written} />}
    </div>
  );
}

function TaskPanel({
  taskId,
  onFinished,
  onWritten,
  onDisplays,
}: {
  taskId: string;
  onFinished?: (task: TaskView, steps: TaskStepView[]) => void;
  /** Told what the finished task wrote — read from the steps, so a reload finds it again. */
  onWritten: (text: string | null) => void;
  /** Told which tables the task computed. */
  onDisplays: (displays: TaskDisplay[]) => void;
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

  const written = task?.status === 'COMPLETED' ? deliverableText(steps) : null;

  useEffect(() => {
    onWritten(written);
  }, [written, onWritten]);

  /* Keyed by content, so a poll that returns the same steps does not redraw. */
  const displays = useMemo(() => taskDisplays(steps), [steps]);
  const displaysKey = JSON.stringify(displays.map((display) => display.kind)) + displays.length;
  useEffect(() => {
    onDisplays(displays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaysKey, onDisplays]);

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
              ? (reasonText(t, task.errorReasonKey) ?? t('failedBeforePlanning'))
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
            {reasonText(t, task.errorReasonKey) ?? t('failedBeforePlanning')}
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
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-xs font-medium text-muted">{t('files')}</span>

          {steps
            .filter((step) => step.artifactIds.length > 0)
            .map((step) =>
              step.artifactIds.map((artifactId) => {
                const info = fileInfo(step.output, artifactId);

                /* A drawing is shown, not listed: it is the answer, and it is small. */
                if (info.kind === 'svg') {
                  return (
                    <DiagramPreview
                      key={artifactId}
                      artifactId={artifactId}
                      name={info.filename ?? step.label}
                    />
                  );
                }

                return (
                  <ArtifactCard
                    key={artifactId}
                    artifactId={artifactId}
                    name={info.filename ?? step.label}
                    kind={info.kind ?? ''}
                    failed={info.validationStatus === 'fail'}
                  />
                );
              }),
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
 * What a step warned about while succeeding.
 *
 * A step can complete and still have something to say — three sources found
 * where ten were expected, a section written without evidence, a coefficient
 * computed on a sample too small to trust. The observation has carried these
 * since Phase A and the panel showed none of them, so partial work looked
 * identical to complete work.
 *
 * That is the more dangerous half of the pair: a failure is visible and gets
 * investigated, while a quiet gap gets submitted.
 */
function stepWarnings(
  step: TaskStepView,
  t: ReturnType<typeof useTranslations>,
): string[] {
  const observation = (
    step.output as {
      observation?: {
        warnings?: { message?: string; metadata?: { count?: number } }[];
      };
    } | null
  )?.observation;

  return (observation?.warnings ?? [])
    .map((warning) => {
      const message = warning.message ?? "";
      const key = findingKey(message);
      if (!key) return message;

      /* A code is for the replanner. The researcher gets the sentence, or nothing. */
      const path = `finding.${key}`;
      return t.has(path)
        ? t(path, { count: warning.metadata?.count ?? 1 })
        : "";
    })
    .filter((message) => message.length > 0)
    .slice(0, 3);
}

/**
 * What a step said it could not find out.
 *
 * Distinct from a warning: a warning describes what happened, this describes
 * what would have made it better. A researcher who is told "I could not
 * determine the sample size" can supply it; one who is told nothing assumes
 * the result is whole.
 */
function stepGaps(step: TaskStepView): string[] {
  const observation = (step.output as { observation?: { missingInformation?: string[] } } | null)
    ?.observation;

  return (observation?.missingInformation ?? []).filter((gap) => gap.length > 0).slice(0, 3);
}

/**
 * The message a failed step recorded, when it left one.
 *
 * Truncated, because a provider error can run to several lines of stack and the
 * step list is not the place for it — the first sentence is what identifies the
 * problem.
 */
/**
 * A reason key's text, or null when there is none.
 *
 * A researcher saw `task.step.reason.stepFailed` printed on screen: the key
 * existed in the code and not in the messages, and `next-intl` renders the
 * path when a lookup misses. That is a debugging aid leaking into a product —
 * it tells them nothing and looks broken.
 *
 * Checked rather than assumed, so a reason added tomorrow degrades to the
 * generic sentence instead of showing its own name.
 */
function reasonText(t: (key: string) => string, reasonKey: string | null): string | null {
  if (!reasonKey) return null;

  const leaf = reasonKey.split('.').pop() ?? '';
  const text = t(`step.reason.${leaf}`);

  /* next-intl returns the key path when the message is missing. */
  return text.startsWith('task.step.reason.') || text === leaf ? null : text;
}

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
  /* Root namespace: the label keys are stored fully qualified. */
  const root = useTranslations();

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
          {/*
            A step the task added to itself is labelled with its capability's
            message key rather than a sentence, and the key was shown as it was.
          */}
          {step.label.startsWith('task.') && root.has(step.label) ? root(step.label) : step.label}
        </span>

        {/*
          A blocked step says why it will not run. Without this it looks
          skipped, and a researcher wonders whether they asked for it.
        */}
        {step.status === 'BLOCKED' && (
          <span className="text-[11px] text-muted">{t('step.blocked')}</span>
        )}

        {/* Set aside, not failed: the task went on without it, and says so. */}
        {step.status === 'SKIPPED' && (
          <span className="text-[11px] text-muted">{t('step.skipped')}</span>
        )}

        {/*
          A completed step that has something to report.

          Rendered quietly — muted, small, at most three — because most steps
          have nothing to say and a panel that shouts on every line teaches the
          researcher to stop reading it.
        */}
        {step.status === 'COMPLETED' &&
          [...stepWarnings(step, t), ...stepGaps(step)].map((note, index) => (
            <span key={index} className="text-[11px] text-muted">
              {note}
            </span>
          ))}

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
              ? (reasonText(t, step.errorReasonKey) ?? t('step.failed', { attempts: step.attempts }))
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


/**
 * A produced file, as something to open rather than only to download.
 *
 * The name opens the document beside the conversation; the arrow still
 * downloads it. Two targets because they are two intentions — reading what was
 * written, and taking the file away — and the old single link served only the
 * second. Outside a chat there is no panel, and the name downloads as before.
 */
function ArtifactCard({
  artifactId,
  name,
  kind,
  failed,
}: {
  artifactId: string;
  name: string;
  kind: string;
  failed: boolean;
}) {
  const t = useTranslations('artifactPanel');
  const panel = useArtifactPanel();
  const href = `/api/artifacts/${artifactId}`;

  const label = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
        <FileText className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col text-start">
        <span className="truncate text-sm text-ink">{name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          {kind && (
            <span className="uppercase" dir="ltr">
              {kind}
            </span>
          )}
          {/*
            The validation verdict beside the file. A document that failed its
            quality check should say so where the person opens it, not
            somewhere they have to go looking.
          */}
          {failed && <AlertTriangle className="size-3 shrink-0 text-danger" aria-hidden />}
          {panel && <span>· {t('open')}</span>}
        </span>
      </span>
    </>
  );

  return (
    <div className="flex items-center gap-1 rounded-xl border border-line-strong bg-surface transition-colors hover:border-primary">
      {panel ? (
        <button
          type="button"
          onClick={() => panel.open(artifactId)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2"
        >
          {label}
        </button>
      ) : (
        <a href={href} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2">
          {label}
        </a>
      )}

      <a
        href={href}
        aria-label={t('download')}
        title={t('download')}
        className="me-1.5 shrink-0 rounded-lg p-2 text-muted hover:bg-subtle hover:text-ink"
      >
        <Download className="size-4" aria-hidden />
      </a>
    </div>
  );
}

/**
 * The file a step produced, wherever the executor put it.
 *
 * A step's stored output is `{ outputs, legacy, observation }`, and the file's
 * name is inside `legacy`. The link read `output.filename`, which was never
 * set, so every file was listed under its step's label — "Generate document" —
 * rather than its own name, and a failed quality check never showed its
 * warning. Both shapes are read, so a row written either way is understood.
 */
function fileInfo(
  output: Record<string, unknown> | null | undefined,
  /**
   * The file asked about, when a step made more than one. The legacy view
   * merges every output into one object, so a step that drew a figure and its
   * PowerPoint copy listed both under the second one's name.
   */
  artifactId?: string,
): {
  filename?: string;
  kind?: string;
  validationStatus?: string;
} {
  const own = (
    (output?.outputs ?? []) as { type?: string; data?: Record<string, unknown> }[]
  ).find((entry) => entry.type === 'artifact.v1' && entry.data?.artifactId === artifactId)?.data;

  if (artifactId && own) {
    const read = (key: string) => (typeof own[key] === 'string' ? (own[key] as string) : undefined);
    return { filename: read('filename'), kind: read('kind'), validationStatus: read('validationStatus') };
  }

  const legacy = (output?.legacy ?? {}) as Record<string, unknown>;
  const pick = (key: string) => {
    const value = output?.[key] ?? legacy[key];
    return typeof value === 'string' ? value : undefined;
  };

  return {
    filename: pick('filename'),
    kind: pick('kind'),
    validationStatus: pick('validationStatus'),
  };
}

/**
 * The text a task produced, set in the thread like any other answer.
 *
 * Outside the panel's border on purpose: the panel is the record of how the
 * work was done, and this is the work. Inside the box it read as a log entry.
 */
function WrittenResult({ text }: { text: string }) {
  const t = useTranslations("task");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* A blocked clipboard leaves the text selectable, which is enough. */
    }
  }

  return (
    <section aria-label={t("result")} className="flex flex-col gap-2">
      <Markdown content={text} compact reading />

      <button
        type="button"
        onClick={() => void copy()}
        className="flex items-center gap-1.5 self-start rounded-lg px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-ink"
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {copied ? t("copied") : t("copy")}
      </button>
    </section>
  );
}

/**
 * A research diagram in the thread, with its two downloads.
 *
 * The PNG is made here, in the browser, from the SVG: the drawing carries its
 * own font, so the canvas renders exactly what is on screen, at three times the
 * size for print. The server never rasterises, which is why the figure looks
 * the same on the page, in the download and in a thesis.
 */
function DiagramPreview({ artifactId, name }: { artifactId: string; name: string }) {
  const t = useTranslations('task');
  const href = `/api/artifacts/${artifactId}`;
  const [busy, setBusy] = useState(false);

  async function downloadPng() {
    setBusy(true);
    try {
      const svg = await (await fetch(href)).text();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image'));
        image.src = url;
      });

      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth * scale;
      canvas.height = image.naturalHeight * scale;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);

      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('png');

      const link = document.createElement('a');
      link.href = URL.createObjectURL(png);
      link.download = `${name.replace(/\.svg$/i, '')}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch {
      /* The SVG link beside it still works; a failed conversion costs one format. */
    } finally {
      setBusy(false);
    }
  }

  return (
    <figure className="flex flex-col gap-2 rounded-xl border border-line-strong bg-white p-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated figure, not a static asset */}
      <img src={href} alt={name} className="h-auto w-full rounded-lg" />
      <figcaption className="flex flex-wrap items-center gap-2 px-1 pb-1">
        <span className="me-auto truncate text-xs text-muted">{name.replace(/\.svg$/i, '')}</span>
        <button
          type="button"
          onClick={() => void downloadPng()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-ink hover:border-primary disabled:opacity-50"
        >
          <Download className="size-3.5" aria-hidden />
          {t('diagram.png')}
        </button>
        <a
          href={href}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-ink hover:border-primary"
        >
          <Download className="size-3.5" aria-hidden />
          {t('diagram.svg')}
        </a>
      </figcaption>
    </figure>
  );
}
