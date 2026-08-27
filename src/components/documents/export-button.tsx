'use client';

import { Download, Loader2, Lock } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function ExportButton({
  projectId,
  allowed,
}: {
  projectId: string;
  allowed: boolean;
}) {
  const t = useTranslations('billing');
  const te = useTranslations('errors');
  const locale = useLocale();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/projects/${projectId}/export?locale=${locale}`, {
      method: 'POST',
    });

    if (!response.ok) {
      setBusy(false);
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string } }
        | null;
      setError(body?.error?.code === 'PLAN_LIMIT' ? te('planLimit') : te('server'));
      return;
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = match?.[1] ? decodeURIComponent(match[1]) : 'research.docx';

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    setBusy(false);
  }

  if (!allowed) {
    return (
      <Button variant="outline" disabled className="justify-start">
        <Lock className="size-4" aria-hidden />
        {t('exportLocked')}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button variant="outline" onClick={download} disabled={busy} className="justify-start">
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Download className="size-4" aria-hidden />
        )}
        {busy ? t('exporting') : t('export')}
      </Button>
      <p className="text-xs text-muted">{t('exportHint')}</p>
    </div>
  );
}
