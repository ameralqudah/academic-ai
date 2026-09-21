'use client';

import { Loader2, MessageCircleQuestion, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useRouter } from '@/i18n/navigation';

/**
 * Work that is still running, shown when the app opens.
 *
 * A researcher who closed the tab during a ten-minute research run had no way
 * to find it again. The task continued on the server and finished into a file
 * nobody was watching — which is worse than it having stopped, because they
 * would have started it again and paid for the same work twice.
 *
 * Shown only when something is unfinished. A banner that says "nothing is
 * running" is noise on every page load, and noise is what makes a banner
 * invisible on the day it matters.
 */

interface ActiveTask {
  id: string;
  status: string;
  request: string;
  conversationId: string | null;
  pendingQuestion: string | null;
  progress: { total: number; completed: number; current: string | null };
}

export function ActiveTasks({ currentConversationId }: { currentConversationId?: string | null }) {
  const t = useTranslations('task');
  const router = useRouter();

  const [tasks, setTasks] = useState<ActiveTask[]>([]);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await fetch('/api/tasks/active');
        const json = await response.json();

        if (!active || !json.ok) return;

        /*
         * The task in this conversation is already on screen as a progress
         * panel. Listing it again would show the same work twice and invite
         * the researcher to open what they are looking at.
         */
        setTasks(
          (json.data.tasks as ActiveTask[]).filter(
            (task) => task.conversationId !== currentConversationId,
          ),
        );
      } catch {
        /*
         * A failed load shows nothing. This is a convenience; failing it
         * loudly would put an error on a page that is otherwise working.
         */
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, [currentConversationId]);

  async function dismiss(taskId: string) {
    /* Taken off the screen first; a failed request brings nothing back worth waiting for. */
    setTasks((current) => current.filter((task) => task.id !== taskId));
    await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  if (tasks.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-3">
      {tasks.map((task) => (
        <div key={task.id} className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={() => {
              /*
               * Opening the conversation rather than the task. The progress panel
               * lives in the thread where the work was asked for, and that thread
               * is also where the answer will appear.
               */
              if (task.conversationId) router.push(`/chat?c=${task.conversationId}`);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface p-3 text-start hover:border-accent"
          >
            {task.status === 'WAITING_FOR_INPUT' ? (
              <MessageCircleQuestion className="size-4 shrink-0 text-accent" aria-hidden />
            ) : (
              <Loader2 className="size-4 shrink-0 animate-spin text-accent" aria-hidden />
            )}

            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-ink">{task.request}</span>

              <span className="text-xs text-muted">
                {/*
                  A task waiting for an answer says so rather than showing a step
                  count: the count has stopped moving and will not move until the
                  researcher acts, so reporting progress would be misleading.
                */}
                {task.status === 'WAITING_FOR_INPUT'
                  ? t('status.WAITING_FOR_INPUT')
                  : `${t(`status.${task.status}`)} · ${t('stepCount', {
                      done: task.progress.completed,
                      total: task.progress.total,
                    })}`}
              </span>
            </span>
          </button>

          {/*
            A way out, for a question nobody is going to answer.

            A task that asked something and was abandoned waited for ever, and
            its card followed the researcher into every conversation with no
            way to be rid of it. Only for waiting tasks: work that is running is
            stopped from its own panel, where what is being stopped is in view —
            one stray click here should not end ten minutes of research.
          */}
          {task.status === 'WAITING_FOR_INPUT' && (
            <button
              type="button"
              aria-label={t('dismiss')}
              title={t('dismiss')}
              onClick={() => void dismiss(task.id)}
              className="flex shrink-0 items-center rounded-xl border border-line bg-surface px-2.5 text-muted hover:border-danger hover:text-danger"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

