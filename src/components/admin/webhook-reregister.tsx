'use client';

import { Loader2, RefreshCcw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';

export function WebhookReregister() {
  const t = useTranslations('admin.billing.webhook');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const locale = useLocale();
  /* The server's own reason when it gives one; the generic line otherwise. */
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setFailure(null);

    try {
      const response = await fetch('/api/admin/billing/webhook', { method: 'POST' });

      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as {
          error?: { message?: string; messageAr?: string };
        } | null;

        setFailure(
          (locale === 'ar' ? json?.error?.messageAr : json?.error?.message) ?? t('reregisterFailed'),
        );
      }
    } catch {
      setFailure(t('reregisterFailed'));
    }

    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={pending}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <RefreshCcw className="size-3.5" aria-hidden />
        )}
        {t('reregister')}
      </Button>
      {failure && <span className="text-xs text-danger">{failure}</span>}
    </div>
  );
}
