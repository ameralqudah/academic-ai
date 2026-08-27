'use client';

import { Loader2, MailCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const te = useTranslations('errors');
  const locale = useLocale() as Locale;

  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(form.get('email') ?? ''), locale }),
    });

    setPending(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string } }
        | null;
      setError(body?.error?.code === 'RATE_LIMITED' ? te('rateLimited') : te('server'));
      return;
    }

    // Success is identical whether or not the address exists.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="success" title={t('forgotSentTitle')}>
          <span className="flex items-start gap-2">
            <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('forgotSentBody')}
          </span>
        </Alert>
        <Link href="/login" className="text-sm font-medium text-primary hover:underline">
          {t('backToLogin')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-ink">{t('forgotTitle')}</h1>
        <p className="text-sm text-muted">{t('forgotSubtitle')}</p>
      </header>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label={t('email')} htmlFor="email" required>
          <TextInput
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            dir="ltr"
            placeholder={t('emailPlaceholder')}
          />
        </Field>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('forgotAction')}
        </Button>
      </form>

      <Link href="/login" className="text-sm text-muted hover:text-ink">
        {t('backToLogin')}
      </Link>
    </div>
  );
}
