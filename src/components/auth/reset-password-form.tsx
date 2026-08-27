'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Link } from '@/i18n/navigation';

export function ResetPasswordForm({ uid, token }: { uid: string; token: string }) {
  const t = useTranslations('auth');
  const te = useTranslations('errors');

  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const linkLooksValid = uid.length > 0 && token.length === 64;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirmPassword = String(form.get('confirmPassword') ?? '');

    if (password !== confirmPassword) {
      setFieldError(t('errors.passwordMismatch'));
      return;
    }

    setPending(true);
    const response = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, token, password, confirmPassword }),
    });
    setPending(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string } }
        | null;
      const code = body?.error?.code;
      if (code === 'CONFLICT' || code === 'NOT_FOUND') setError(t('invalidLink'));
      else if (code === 'VALIDATION') setFieldError(t('errors.weakPassword'));
      else if (code === 'RATE_LIMITED') setError(te('rateLimited'));
      else setError(te('server'));
      return;
    }

    setDone(true);
  }

  if (!linkLooksValid) {
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="danger">{t('invalidLink')}</Alert>
        <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">
          {t('forgotAction')}
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-6">
        <Alert tone="success" title={t('resetDoneTitle')}>
          <span className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('resetDoneBody')}
          </span>
        </Alert>
        <Button asChild className="w-full">
          <Link href="/login">{t('loginAction')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-ink">{t('resetTitle')}</h1>
        <p className="text-sm text-muted">{t('resetSubtitle')}</p>
      </header>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('password')}
          htmlFor="password"
          required
          hint={t('passwordPlaceholder')}
          error={fieldError ?? undefined}
        >
          <TextInput
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            dir="ltr"
          />
        </Field>

        <Field label={t('confirmPassword')} htmlFor="confirmPassword" required>
          <TextInput
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            dir="ltr"
          />
        </Field>

        <Button type="submit" disabled={pending} className="mt-1 w-full">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('resetAction')}
        </Button>
      </form>
    </div>
  );
}
