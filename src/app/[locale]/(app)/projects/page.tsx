import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ProjectCard } from '@/components/app/project-card';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { listProjects } from '@/server/services/project.service';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'projects' });
  return { title: t('title') };
}

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'projects' });
  const projects = await listProjects(user.id);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
          <p className="text-sm text-muted">{t('subtitle')}</p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus className="size-4" aria-hidden />
            {t('newProject')}
          </Link>
        </Button>
      </header>

      {projects.length === 0 ? (
        <p className="surface-card p-8 text-sm text-muted">{t('empty')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}
