import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AgentChat } from '@/components/agent/agent-chat';
import { requirePageUser } from '@/server/auth/guards';
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
export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ project?: string; prompt?: string; c?: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const { project, prompt } = await searchParams;
  const t = await getTranslations({ locale, namespace: 'agent' });

  const projects = await projectsRepo.listByUser(user.id, 50);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </div>
      <AgentChat
        locale={locale === 'en' ? 'en' : 'ar'}
        projects={projects.map((entry) => ({ id: entry.id, title: entry.title }))}
        initialProjectId={project ?? null}
        /*
         * A starting phrase, when the user arrived from a sidebar entry like
         * "Academic search". The key is resolved to text here rather than
         * passed through the URL, so a crafted link cannot put arbitrary
         * content into someone's composer.
         */
        initialDraft={
          prompt === 'academicSearchPrompt' || prompt === 'literatureReviewPrompt'
            ? t(prompt)
            : undefined
        }
      />
    </div>
  );
}
