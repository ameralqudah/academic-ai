import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { MemoriesPanel, type MemoryItem } from '@/components/memories/memories-panel';
import { EmailVerification } from '@/components/settings/email-verification';
import { SettingsForm } from '@/components/settings/settings-form';
import { ThemeToggle } from '@/components/theme-toggle';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import type { Locale } from '@/i18n/routing';
import { requirePageUser } from '@/server/auth/guards';
import { contextV2Enabled } from '@/server/context/flags';
import { AppError } from '@/server/http/errors';
import { listMemoriesIn } from '@/server/memory/service';
import * as usersRepo from '@/server/repositories/users.repository';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'settings' });
  return { title: t('title') };
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const t = await getTranslations({ locale, namespace: 'settings' });
  const tc = await getTranslations({ locale, namespace: 'common' });

  const settings = await usersRepo.ensureSettings(user.id);
  /* Read from the database, not the session: a link confirmed a moment ago shows at once. */
  const account = await usersRepo.findById(user.id);

  /* P1-E: what Academic AI remembers, only with Context V2 on. Unavailable (RLS not enforceable) is shown, not thrown. */
  const memoriesOn = contextV2Enabled();
  let memories: MemoryItem[] | null = null;
  if (memoriesOn) {
    try {
      memories = JSON.parse(JSON.stringify((await listMemoriesIn({ scope: 'user' }, user.id)).memories)) as MemoryItem[];
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'UNAVAILABLE')) throw error;
    }
  }
  const tm = memoriesOn ? await getTranslations({ locale, namespace: 'memories' }) : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </header>

      <Card className="flex flex-col gap-5">
        <CardHeader title={t('account')} />
        <SettingsForm
          initial={{
            name: user.name ?? '',
            email: user.email,
            locale: user.locale as Locale,
            citationStyle: settings.citationStyle,
            defaultAcademicField: settings.defaultAcademicField ?? 'educationalSciences',
          }}
        />
      </Card>

      <EmailVerification email={user.email} verified={Boolean(account?.emailVerified)} />

      {memoriesOn && tm ? (
        memories ? (
          <MemoriesPanel endpoint="/api/v1/me/memories" locale={locale === 'ar' ? 'ar' : 'en'} initial={memories} canAdd title={tm('title')} intro={tm('intro')} />
        ) : (
          <Alert tone="warning">{tm('unavailable')}</Alert>
        )
      ) : null}

      <Card className="flex flex-row items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-ink">{tc('theme')}</p>
          <p className="text-xs text-muted">
            {tc('light')} · {tc('dark')} · {tc('system')}
          </p>
        </div>
        <ThemeToggle />
      </Card>
    </div>
  );
}
