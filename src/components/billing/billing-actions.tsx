'use client';

import { CreditCard, Loader2, XCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

type Busy = 'checkout' | 'portal' | 'cancel' | null;

export function BillingActions({
  isPro,
  cancelAtPeriodEnd,
  proPlanCode,
  supportsPortal,
}: {
  isPro: boolean;
  cancelAtPeriodEnd: boolean;
  proPlanCode: string;
  supportsPortal: boolean;
}) {
  const t = useTranslations('billing');
  const te = useTranslations('errors');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();

  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post<T>(url: string, payload: unknown): Promise<T | null> {
    setError(null);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as
      | { ok: true; data: T }
      | { ok: false; error: { code: string } };

    if (!response.ok || !body.ok) {
      setError(te('server'));
      return null;
    }
    return body.data;
  }

  async function upgrade() {
    setBusy('checkout');
    const data = await post<{ url: string; applied: boolean }>('/api/billing/checkout', {
      planCode: proPlanCode,
      locale,
    });
    setBusy(null);
    if (!data) return;

    // Manual billing applies the change server-side and hands back an internal
    // path; a real gateway hands back its own hosted checkout URL.
    if (data.applied) router.refresh();
    else window.location.assign(data.url);
  }

  async function portal() {
    setBusy('portal');
    const data = await post<{ url: string }>('/api/billing/portal', { locale });
    setBusy(null);
    if (data?.url) window.location.assign(data.url);
  }

  async function cancel() {
    setBusy('cancel');
    const data = await post<{ canceled: boolean }>('/api/billing/cancel', { atPeriodEnd: true });
    setBusy(null);
    setConfirming(false);
    if (data) router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {confirming ? (
        <Alert tone="warning" title={t('cancelTitle')}>
          <p className="mb-3">{t('cancelBody')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="danger" onClick={cancel} disabled={busy !== null}>
              {busy === 'cancel' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t('cancelConfirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {t('keepPlan')}
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {!isPro ? (
          <Button variant="upgrade" onClick={upgrade} disabled={busy !== null}>
            {busy === 'checkout' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <CreditCard className="size-4" aria-hidden />
            )}
            {busy === 'checkout' ? t('upgrading') : t('upgrade')}
          </Button>
        ) : null}

        {isPro && supportsPortal ? (
          <Button variant="outline" onClick={portal} disabled={busy !== null}>
            {busy === 'portal' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <CreditCard className="size-4" aria-hidden />
            )}
            {t('manage')}
          </Button>
        ) : null}

        {isPro && !cancelAtPeriodEnd && !confirming ? (
          <Button variant="ghost" className="text-danger" onClick={() => setConfirming(true)}>
            <XCircle className="size-4" aria-hidden />
            {t('cancel')}
          </Button>
        ) : null}
      </div>

      <p className="sr-only">{tc('close')}</p>
    </div>
  );
}
