'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

type State = 'working' | 'done' | 'invalid' | 'error';

/**
 * Confirms the address as soon as the page opens.
 *
 * The link itself is the proof, so there is nothing to ask the user; a button
 * would only add a click. The request is sent once, even under React's
 * development double-render, because a second send would find the token
 * already consumed and report a working link as invalid.
 */
export function VerifyEmailPanel({ uid, token }: { uid: string; token: string }) {
  const t = useTranslations('auth');
  const linkLooksValid = uid.length > 0 && token.length === 64;
  const [state, setState] = useState<State>(linkLooksValid ? 'working' : 'invalid');
  const sent = useRef(false);

  useEffect(() => {
    if (!linkLooksValid || sent.current) return;
    sent.current = true;

    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, token }),
    })
      .then(async (response) => {
        if (response.ok) return setState('done');
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        setState(code === 'CONFLICT' || code === 'NOT_FOUND' || code === 'VALIDATION' ? 'invalid' : 'error');
      })
      .catch(() => setState('error'));
  }, [linkLooksValid, uid, token]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-ink">{t('verifyTitle')}</h1>
      </header>

      {state === 'working' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('verifyWorking')}
        </p>
      )}

      {state === 'done' && (
        <Alert tone="success" title={t('verifyDoneTitle')}>
          <span className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('verifyDoneBody')}
          </span>
        </Alert>
      )}

      {state === 'invalid' && <Alert tone="danger">{t('verifyInvalid')}</Alert>}
      {state === 'error' && <Alert tone="danger">{t('verifyError')}</Alert>}

      {state !== 'working' && (
        <Button asChild className="w-full">
          <Link href="/settings">{t('verifyContinue')}</Link>
        </Button>
      )}
    </div>
  );
}
