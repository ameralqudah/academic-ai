import type { ReactNode } from 'react';

import { AppShell } from '@/components/app/app-shell';
import { UsageMeter } from '@/components/app/usage-meter';
import { requirePageUser } from '@/server/auth/guards';
import { listRecent } from '@/server/services/chat.service';
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

  /*
   * Recent conversations for the sidebar, loaded here rather than in the client
   * component that displays them. The shell is a client component and has no
   * business reaching for data; the layout is a server component and does.
   */
  const conversations = await listRecent(user.id, { mode: 'AGENT', limit: 20 });

  return (
    <AppShell
      userName={user.name ?? user.email}
      userEmail={user.email}
      isAdmin={hasAdminAccess(user)}
      conversations={conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
      }))}
      aside={<UsageMeter locale={locale} summary={summary} />}
    >
      {children}
    </AppShell>
  );
}
