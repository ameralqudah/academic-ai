import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AgentChat } from '@/components/agent/agent-chat';
import { requirePageUser } from '@/server/auth/guards';
import { getThread } from '@/server/services/chat.service';
import * as projectsRepo from '@/server/repositories/projects.repository';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'agent' });
  return { title: t('title') };
}

/**
 * The conversational entry point.
 *
 * Added beside the existing pages rather than replacing them. The wizard, the
 * project view and the data inspector all still work exactly as they did — this
 * is a second door into the same building.
 *
 * A project is optional and unselected by default. Most of what the assistant
 * does — analysing a file, checking a scale, choosing a test — needs no project
 * at all, and making one mandatory would tax every user with an empty container
 * before they could ask anything.
 *
 * `?project=<id>` pre-selects one. That is the seam for the shortcut planned
 * inside the project page: it becomes a link, and nothing here changes.
 */
/**
 * Turns saved messages into the shape the chat renders.
 *
 * A stored assistant message carries its structured results in `payload`, so a
 * reopened conversation redraws the actual analysis table rather than the
 * prose that described it. That is the reason results are stored as objects.
 */
function toTurns(
  messages: { id: string; role: string; content: string; payload: Record<string, unknown> | null }[],
) {
  return messages.map((message) => {
    if (message.role === 'USER') {
      return { id: message.id, role: 'user' as const, text: message.content };
    }

    const results = (message.payload?.results ?? []) as {
      kind: string;
      runId?: string;
      payload: unknown;
    }[];

    return {
      id: message.id,
      role: 'assistant' as const,
      text: message.content,
      results,
    };
  });
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ project?: string; prompt?: string; c?: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const { project, prompt, c: conversationId } = await searchParams;

  /*
   * A saved conversation, when the URL names one.
   *
   * Loaded here rather than fetched by the client on mount: the thread is part
   * of the page, and fetching it after render would show an empty conversation
   * for a moment every time someone opens one from the sidebar.
   *
   * A conversation belonging to someone else throws, which is correct — but it
   * should not take down the page, so an unknown id simply opens a new chat.
   */
  const thread = conversationId
    ? await getThread(conversationId, user.id).catch(() => null)
    : null;
  const t = await getTranslations({ locale, namespace: 'agent' });

  const projects = await projectsRepo.listByUser(user.id, 50);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </div>
      {/*
        Keyed by the conversation, which forces a fresh component when the user
        moves between threads.
        
        Without it, `useState(initialTurns)` reads its value once and keeps it:
        clicking a second conversation in the sidebar changes the URL and the
        props, and leaves the first conversation on screen. Remounting is the
        correct answer rather than syncing props into state — a chat is
        genuinely a different thing when it is a different conversation.
      */}
      <AgentChat
        key={thread?.conversation.id ?? 'new'}
        locale={locale === 'en' ? 'en' : 'ar'}
        projects={projects.map((entry) => ({ id: entry.id, title: entry.title }))}
        initialProjectId={project ?? thread?.conversation.projectId ?? null}
        conversationId={thread?.conversation.id ?? null}
        initialTurns={thread ? toTurns(thread.messages) : undefined}
        initialBranches={thread?.branchPoints ?? []}
        /*
         * A starting phrase, when the user arrived from a sidebar entry like
         * "Academic search". The key is resolved to text here rather than
         * passed through the URL, so a crafted link cannot put arbitrary
         * content into someone's composer.
         */
        initialDraft={
          prompt === 'academicSearchPrompt' ||
          prompt === 'literatureReviewPrompt' ||
          prompt === 'webSearchPrompt' ||
          prompt === 'deepResearchPrompt'
            ? t(prompt)
            : undefined
        }
      />
    </div>
  );
}
