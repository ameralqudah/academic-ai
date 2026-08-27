'use client';

import { Loader2 } from 'lucide-react';
import { signIn } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'confirmPassword', string>>;

export function RegisterForm({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations('auth');
  const te = useTranslations('errors');
  const tl = useTranslations('landing');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      confirmPassword: String(form.get('confirmPassword') ?? ''),
      locale,
    };

    if (payload.password !== payload.confirmPassword) {
      setFieldErrors({ confirmPassword: t('errors.passwordMismatch') });
      return;
    }

    setPending(true);

    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as
      | { ok: true }
      | { ok: false; error: { code: string; details?: unknown } };

    if (!response.ok || !body.ok) {
      setPending(false);
      const code = body.ok ? '' : body.error.code;
      if (code === 'CONFLICT') setError(t('errors.emailTaken'));
      else if (code === 'VALIDATION') setFieldErrors({ password: t('errors.weakPassword') });
      else if (code === 'RATE_LIMITED') setError(te('rateLimited'));
      else setError(t('errors.generic'));
      return;
    }

    await signIn('credentials', {
      email: payload.email,
      password: payload.password,
      redirect: false,
    });

    router.refresh();
    router.push('/dashboard');
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-ink">{t('registerTitle')}</h1>
        <p className="text-sm text-muted">{t('registerSubtitle')}</p>
      </header>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label={t('name')} htmlFor="name" required error={fieldErrors.name}>
          <TextInput
            id="name"
            name="name"
            autoComplete="name"
            required
            minLength={2}
            placeholder={t('namePlaceholder')}
          />
        </Field>

        <Field label={t('email')} htmlFor="email" required error={fieldErrors.email}>
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

        <Field
          label={t('password')}
          htmlFor="password"
          required
          error={fieldErrors.password}
          hint={t('passwordPlaceholder')}
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

        <Field
          label={t('confirmPassword')}
          htmlFor="confirmPassword"
          required
          error={fieldErrors.confirmPassword}
        >
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
          {t('registerAction')}
        </Button>

        <p className="text-xs leading-relaxed text-muted">
          {t('acceptTerms')}{' '}
          <Link href="/terms" className="underline hover:text-ink">
            {tl('terms')}
          </Link>
          {' · '}
          <Link href="/privacy" className="underline hover:text-ink">
            {tl('privacy')}
          </Link>
        </p>
      </form>

      {googleEnabled ? (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-line" />
            {t('orContinueWith')}
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => signIn('google', { callbackUrl: `/${locale}/dashboard` })}
          >
            {t('google')}
          </Button>
        </>
      ) : null}

      <p className="text-sm text-muted">
        {t('haveAccount')}{' '}
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t('loginAction')}
        </Link>
      </p>
    </div>
  );
}
