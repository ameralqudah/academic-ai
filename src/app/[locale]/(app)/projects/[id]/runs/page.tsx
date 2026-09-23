import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { RunsPanel } from '@/components/runs/runs-panel';
import { Link } from '@/i18n/navigation';
import { requirePageUser } from '@/server/auth/guards';
import { requireProjectPage } from '@/server/pages/project-page';
import { listRuns, runsEnabled } from '@/server/runs/service';
import { listProjectDatasets } from '@/server/stats/versions';

type Props = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'runs' });
  return { title: t('title') };
}

/**
 * Research runs (P1-D): start a run from an intent, watch its steps, approve
 * exactly the actions that need it, cancel. Behind FF_RUNS (and FF_GRAPH).
 */
export default async function RunsPage({ params }: Props) {
  const { locale, id } = await params;
  if (!runsEnabled()) notFound();
  const user = await requirePageUser(locale);
  const project = await requireProjectPage(id, user.id);
  const [runs, datasets] = await Promise.all([listRuns({ userId: user.id }, id), listProjectDatasets({ userId: user.id }, id)]);
  const versions = datasets.flatMap((dataset) => dataset.versions.map((version) => ({ id: version.id, label: `${dataset.name} · v${version.versionNo} (${version.rows})` })));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={`/projects/${id}`} className="text-sm text-muted transition-colors hover:text-ink">
          {project.title}
        </Link>
      </header>
      <RunsPanel projectId={id} locale={locale === 'ar' ? 'ar' : 'en'} initialRuns={JSON.parse(JSON.stringify(runs))} versions={versions} />
    </div>
  );
}
