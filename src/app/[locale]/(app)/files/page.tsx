import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { FileList, type DatasetSummary } from '@/components/files/file-list';
import { requirePageUser } from '@/server/auth/guards';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'files' });

  return { title: t('title') };
}

/**
 * Everything the researcher has uploaded.
 *
 * Loaded on the server rather than fetched on mount: the list is the page, and
 * fetching it after render shows an empty state for a moment every time — which
 * reads as "you have no files" to someone who has forty.
 */
export default async function FilesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'files' });

  const datasets = await datasetsRepo.listByUser(user.id);

  /*
   * Project titles resolved in one pass rather than per dataset. Forty files
   * across five projects would otherwise be forty queries for five answers.
   */
  const projectIds = [...new Set(datasets.map((dataset) => dataset.projectId).filter(Boolean))];
  const projects = await Promise.all(
    projectIds.map((id) => projectsRepo.findOwned(id as string, user.id)),
  );

  const titleById = new Map(
    projects.filter(Boolean).map((project) => [project?.id as string, project?.title as string]),
  );

  const summaries: DatasetSummary[] = datasets.map((dataset) => ({
    id: dataset.id,
    originalName: dataset.originalName,
    rowCount: dataset.rowCount ?? 0,
    columnCount: dataset.columnCount ?? 0,
    sizeBytes: dataset.byteSize,
    createdAt: dataset.createdAt.toISOString(),
    projectId: dataset.projectId,
    projectTitle: dataset.projectId ? titleById.get(dataset.projectId) ?? null : null,
    /*
     * A cleaned copy is shown as such. It derives from an original and deleting
     * that original takes it with it — so a researcher choosing what to remove
     * needs to see which is which.
     */
    kind: dataset.kind,
  }));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle', { count: summaries.length })}</p>
      </header>

      <FileList datasets={summaries} />
    </div>
  );
}
