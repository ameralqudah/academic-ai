import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AgentChat } from '@/components/agent/agent-chat';
import { requirePageUser } from '@/server/auth/guards';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'agent' });
  return { title: t('title') };
}

/**
 * The conversational entry point.
 *
 * Added beside the existing pages rather than replacing them. The wizard, the
 * project view and the data inspector all still work exactly as they did — this
 * is a second door into the same building, and the day it is clearly better
 * than the first door is the day to think about which one is the front one.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'agent' });

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </div>
      <AgentChat locale={locale === 'en' ? 'en' : 'ar'} />
    </div>
  );
}
