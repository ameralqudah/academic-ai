import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { MemoriesPanel, type MemoryItem } from '@/components/memories/memories-panel';
import { Alert } from '@/components/ui/alert';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { contextV2Enabled } from '@/server/context/flags';
import { AppError } from '@/server/http/errors';
import { listMemoriesIn, projectTitleForMember } from '@/server/memory/service';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'memories' });
  return { title: t('projectTitle') };
}

/**
 * What Academic AI remembers about a project (P1-E). Behind FF_CONTEXT_V2.
 * Member-scoped: any member (VIEWER and up) sees the project's memories; the
 * API decides every change. A non-member, or a project that does not exist,
 * is the 404 page.
 */
export default async function ProjectMemoriesPage({ params }: Props) {
  const { locale, id } = await params;
  if (!contextV2Enabled()) notFound();
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'memories' });

  let project: { title: string; role: string };
  try {
    project = await projectTitleForMember(id, user.id);
  } catch (error) {
    if (error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound();
    throw error;
  }

  let memories: MemoryItem[] | null = null;
  try {
    memories = JSON.parse(JSON.stringify((await listMemoriesIn({ scope: 'project', projectId: id }, user.id)).memories)) as MemoryItem[];
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'UNAVAILABLE')) throw error;
  }
  const canAdd = project.role === 'EDITOR' || project.role === 'OWNER';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
      </header>
      {memories ? (
        <MemoriesPanel
          endpoint={`/api/v1/projects/${id}/memories`}
          locale={locale === 'ar' ? 'ar' : 'en'}
          initial={memories}
          canAdd={canAdd}
          title={t('projectTitle')}
          intro={t('projectIntro')}
          readOnlyNote={!canAdd}
        />
      ) : (
        <Alert tone="warning">{t('unavailable')}</Alert>
      )}
    </div>
  );
}
