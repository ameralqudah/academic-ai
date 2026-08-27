import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { AdminTabs } from '@/components/admin/admin-tabs';
import { requirePageAdmin } from '@/server/auth/guards';

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requirePageAdmin(locale);
  const t = await getTranslations({ locale, namespace: 'admin' });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <AdminTabs />
      </header>
      {children}
    </div>
  );
}
