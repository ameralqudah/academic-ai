import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { DataInspector } from '@/components/analysis/data-inspector';
import { requirePageUser } from '@/server/auth/guards';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'analysis' });
  return { title: t('title') };
}

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'analysis' });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </div>
      <DataInspector />
    </div>
  );
}
