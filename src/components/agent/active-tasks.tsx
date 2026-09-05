'use client';

import { Loader2, MessageCircleQuestion } from 'lucide-react';
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

  if (tasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => {
            /*
             * Opening the conversation rather than the task. The progress panel
             * lives in the thread where the work was asked for, and that thread
             * is also where the answer will appear.
             */
            if (task.conversationId) router.push(`/chat?c=${task.conversationId}`);
          }}
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface p-3 text-start hover:border-accent"
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
      ))}
    </div>
  );
}

