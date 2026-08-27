'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { SectionKey } from '@/config/research';
import { useRouter } from '@/i18n/navigation';
import { sectionI18nKey } from '@/lib/sections';

export function BuildNextSection({
  projectId,
  nextSection,
}: {
  projectId: string;
  nextSection: SectionKey | null;
}) {
  const td = useTranslations('documents');
  const ts = useTranslations('sections');
  const te = useTranslations('errors');
  const router = useRouter();

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!nextSection) {
    return <Alert tone="success">{td('allDone')}</Alert>;
  }

  async function build() {
    setRunning(true);
    setError(null);

    const response = await fetch('/api/ai/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sectionKey: nextSection }),
    });

    setRunning(false);

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string } }
        | null;
      const code = body?.error?.code;
      setError(
        code === 'PLAN_LIMIT'
          ? te('planLimit')
          : code === 'AI_UNAVAILABLE'
            ? te('aiUnavailable')
            : code === 'RATE_LIMITED'
              ? te('rateLimited')
              : te('server'),
      );
      return;
    }

    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button onClick={build} disabled={running} className="self-start">
        {running ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        {td('buildNext')} — {ts(sectionI18nKey(nextSection))}
      </Button>
    </div>
  );
}

export function DocTypeSwitch({
  projectId,
  current,
  target,
}: {
  projectId: string;
  current: string;
  target: 'PAPER' | 'PROPOSAL' | 'THESIS';
}) {
  const td = useTranslations('documents');
  const tp = useTranslations('projects');
  const te = useTranslations('errors');
  const router = useRouter();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchType() {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: target }),
    });

    setPending(false);
    if (!response.ok) {
      setError(te('server'));
      return;
    }
    router.refresh();
  }

  return (
    <Alert
      tone="info"
      title={td('wrongDocType', {
        current: tp(`docTypes.${current}`),
        target: tp(`docTypes.${target}`),
      })}
      action={
        <Button size="sm" onClick={switchType} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pending ? td('switching') : td('switchTo')}
        </Button>
      }
    >
      {error}
    </Alert>
  );
}
