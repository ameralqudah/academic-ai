'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errors');
  const tc = useTranslations('common');

  useEffect(() => {
    // The digest is what ties this screen to a server log line.
    console.error('app.error', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <h1 className="text-xl font-semibold text-ink">{t('server')}</h1>
      {error.digest ? (
        <p dir="ltr" className="font-mono text-xs text-muted">
          {error.digest}
        </p>
      ) : null}
      <Button onClick={reset}>{tc('continue')}</Button>
    </div>
  );
}
