'use client';

import { Loader2, RefreshCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';

export function WebhookReregister() {
  const t = useTranslations('admin.billing.webhook');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setPending(true);
    setFailed(false);

    try {
      const response = await fetch('/api/admin/billing/webhook', { method: 'POST' });
      if (!response.ok) setFailed(true);
    } catch {
      setFailed(true);
    }

    setPending(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <Button size="sm" variant="outline" onClick={() => void run()} disabled={pending}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <RefreshCcw className="size-3.5" aria-hidden />
        )}
        {t('reregister')}
      </Button>
      {failed && <span className="text-xs text-danger">{t('reregisterFailed')}</span>}
    </div>
  );
}
