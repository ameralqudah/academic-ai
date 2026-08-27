'use client';

import { Loader2 } from 'lucide-react';
import { signIn } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Link, useRouter } from '@/i18n/navigation';

export function LoginForm({ googleEnabled }: { googleEnabled: boolean }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await signIn('credentials', {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      redirect: false,
    });

    if (result?.error) {
      setError(t('errors.invalidCredentials'));
      setPending(false);
      return;
    }

    // `refresh()` first so the server components re-render with the new session
    // cookie; `push()` then lands on an already-authenticated dashboard.
    router.refresh();
    router.push('/dashboard');
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-ink">{t('loginTitle')}</h1>
        <p className="text-sm text-muted">{t('loginSubtitle')}</p>
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

        <Field label={t('password')} htmlFor="password" required>
          <TextInput
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            dir="ltr"
            placeholder={t('passwordPlaceholder')}
          />
        </Field>

        <Button type="submit" disabled={pending} className="mt-1 w-full">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t('loginAction')}
        </Button>

        <Link
          href="/forgot-password"
          className="self-start text-sm text-muted transition-colors hover:text-ink"
        >
          {t('forgotPassword')}
        </Link>
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
        {t('noAccount')}{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          {t('registerAction')}
        </Link>
      </p>
    </div>
  );
}
