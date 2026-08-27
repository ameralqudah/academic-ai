import type { ReactNode } from 'react';

import { AppShell } from '@/components/app/app-shell';
import { UsageMeter } from '@/components/app/usage-meter';
import { requirePageUser } from '@/server/auth/guards';
import { getSummary } from '@/server/services/usage.service';
import { hasAdminAccess } from '@/server/auth/owner';

export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const summary = await getSummary(user.id);

  return (
    <AppShell
      userName={user.name ?? user.email}
      userEmail={user.email}
      isAdmin={hasAdminAccess(user)}
      aside={<UsageMeter locale={locale} summary={summary} />}
    >
      {children}
    </AppShell>
  );
}
