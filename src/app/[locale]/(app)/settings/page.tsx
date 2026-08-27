import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SettingsForm } from '@/components/settings/settings-form';
import { ThemeToggle } from '@/components/theme-toggle';
import { Card, CardHeader } from '@/components/ui/card';
import type { Locale } from '@/i18n/routing';
import { requirePageUser } from '@/server/auth/guards';
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
