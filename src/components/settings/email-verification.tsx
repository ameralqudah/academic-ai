'use client';

import { CheckCircle2, Loader2, MailWarning } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * Whether the account's address is confirmed, and a way to confirm it.
 *
 * Nothing in the app is locked behind this; it matters for owner rights and
 * for linking a Google sign-in to a password account, so it lives in settings
 * rather than as a banner over every page.
 */
export function EmailVerification({ email, verified }: { email: string; verified: boolean }) {
  const t = useTranslations('auth');
  const te = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  async function resend() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/auth/verify-email/resend', { method: 'POST' });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: { alreadyVerified?: boolean }; error?: { code?: string } }
        | null;
      if (response.ok && body?.ok) {
        setMessage({ tone: 'success', text: body.data?.alreadyVerified ? t('verifyStatusVerified') : t('verifyResent') });
      } else {
        setMessage({ tone: 'danger', text: body?.error?.code === 'RATE_LIMITED' ? te('rateLimited') : te('server') });
      }
    } catch {
      setMessage({ tone: 'danger', text: te('server') });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="surface-card flex flex-col gap-3 p-5 sm:p-6">
      <h2 className="text-base font-semibold text-ink">{t('verifySectionTitle')}</h2>
      {verified ? (
        <p className="flex items-center gap-2 text-sm text-ink-soft">
          <CheckCircle2 className="size-4 text-primary" aria-hidden />
          <span>
            {t('verifyStatusVerified')} <bdi dir="ltr">{email}</bdi>
          </span>
        </p>
      ) : (
        <>
          <p className="flex items-start gap-2 text-sm text-ink-soft">
            <MailWarning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <span>
              {t('verifyStatusUnverified')} <bdi dir="ltr">{email}</bdi>. {t('verifyStatusBody')}
            </span>
          </p>
          <div>
            <Button type="button" variant="secondary" onClick={() => void resend()} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t('verifyResend')}
            </Button>
          </div>
        </>
      )}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </section>
  );
}
