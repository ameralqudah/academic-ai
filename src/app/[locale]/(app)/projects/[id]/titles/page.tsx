import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TitleGenerator } from '@/components/titles/title-generator';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { listTitles } from '@/server/services/ai.service';
import { requireProjectPage } from '@/server/pages/project-page';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'titles' });
  return { title: t('title') };
}

export default async function TitlesPage({ params }: Props) {
  const { locale, id } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'titles' });

  const [project, titles] = await Promise.all([
    requireProjectPage(id, user.id),
    listTitles(user.id, id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/projects/${id}`}
          className="text-sm text-muted transition-colors hover:text-ink"
        >
          {project.title}
        </Link>
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <p className="max-w-[62ch] text-sm text-muted">{t('subtitle')}</p>
      </header>

      <TitleGenerator projectId={id} initialTitles={titles} />
    </div>
  );
}
