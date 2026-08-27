import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CreateProjectForm } from '@/components/projects/create-project-form';
import { requirePageUser } from '@/server/auth/guards';
import { getSummary } from '@/server/services/usage.service';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'projects.create' });
  return { title: t('title') };
}

export default async function NewProjectPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'projects.create' });
  const summary = await getSummary(user.id);

  const canCreate =
    summary.projects.limit < 0 || summary.projects.used < summary.projects.limit;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </header>

      <div className="surface-card p-6 sm:p-8">
        <CreateProjectForm canCreate={canCreate} />
      </div>
    </div>
  );
}
