import { getTranslations } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('errors');

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="tabular text-6xl font-bold text-line-strong">404</p>
      <h1 className="text-xl font-semibold text-ink">{t('notFound')}</h1>
      <p className="max-w-[46ch] text-sm text-muted">{t('notFoundBody')}</p>
      <Button asChild>
        <Link href="/">{t('backHome')}</Link>
      </Button>
    </div>
  );
}
