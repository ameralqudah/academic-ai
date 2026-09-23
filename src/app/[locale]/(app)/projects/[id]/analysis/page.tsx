import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { StatsWorkbench } from '@/components/analysis/stats-workbench';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { graphEnabled } from '@/server/graph/access';
import { requireProjectPage } from '@/server/pages/project-page';
import { listProjectDatasets } from '@/server/stats/versions';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'stats' });
  return { title: t('title') };
}

/**
 * The deterministic analysis workbench (P1-C): the minimum interface that
 * proves the chain — data version → specification → engine run → verified
 * results → provenance → manuscript. Behind FF_GRAPH, like the rest of the
 * research workspace.
 */
export default async function AnalysisPage({ params }: Props) {
  const { locale, id } = await params;
  if (!graphEnabled()) notFound();
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'stats' });
  const project = await requireProjectPage(id, user.id);
  const datasets = await listProjectDatasets({ userId: user.id }, id);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <p className="max-w-[70ch] text-sm text-muted">{t('intro')}</p>
      </header>
      <StatsWorkbench projectId={id} locale={locale === 'ar' ? 'ar' : 'en'} initialDatasets={JSON.parse(JSON.stringify(datasets))} />
    </div>
  );
}
