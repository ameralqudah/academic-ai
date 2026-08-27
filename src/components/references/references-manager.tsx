'use client';

import { AlertTriangle, Check, ExternalLink, Loader2, Plus, Trash2, Wand2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select, TextArea } from '@/components/ui/field';
import { CITATION_STYLES } from '@/config/research';
import type { ReferenceRow } from '@/server/db/schema';

type Style = (typeof CITATION_STYLES)[number];

export function ReferencesManager({
  projectId,
  initial,
  defaultStyle,
}: {
  projectId: string;
  initial: ReferenceRow[];
  defaultStyle: Style;
}) {
  const t = useTranslations('documents');
  const tt = useTranslations('tools');
  const tc = useTranslations('common');
  const te = useTranslations('errors');

  const [items, setItems] = useState(initial);
  const [raw, setRaw] = useState('');
  const [style, setStyle] = useState<Style>(defaultStyle);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (raw.trim().length < 10) return;
    setAdding(true);
    setError(null);

    const response = await fetch(`/api/projects/${projectId}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText: raw, style }),
    });

    setAdding(false);
    if (!response.ok) {
      setError(te('server'));
      return;
    }

    const body = (await response.json()) as { data: ReferenceRow };
    setItems((current) => [body.data, ...current]);
    setRaw('');
  }

  async function patch(id: string, payload: Record<string, unknown>) {
    setBusyId(id);
    setError(null);

    const response = await fetch(`/api/projects/${projectId}/references/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setBusyId(null);
    if (!response.ok) {
      setError(te('server'));
      return;
    }

    const body = (await response.json()) as { data: ReferenceRow };
    setItems((current) => current.map((item) => (item.id === id ? body.data : item)));
  }

  async function remove(id: string) {
    setBusyId(id);
    const response = await fetch(`/api/projects/${projectId}/references/${id}`, {
      method: 'DELETE',
    });
    setBusyId(null);
    if (response.ok) setItems((current) => current.filter((item) => item.id !== id));
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert tone="warning" title={t('unverified')}>
        {t('verifyHint')}
      </Alert>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <section className="surface-card flex flex-col gap-4 p-5">
        <Field label={t('referenceRaw')} htmlFor="reference-raw">
          <TextArea
            id="reference-raw"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={3}
            dir="auto"
            maxLength={2000}
            placeholder={t('referenceRawPlaceholder')}
          />
        </Field>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label={tt('options.style')} htmlFor="reference-style">
            <Select
              id="reference-style"
              value={style}
              onChange={(event) => setStyle(event.target.value as Style)}
              className="w-44"
            >
              {CITATION_STYLES.map((value) => (
                <option key={value} value={value}>
                  {tt(`options.${value}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Button onClick={add} disabled={adding || raw.trim().length < 10}>
            {adding ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
            {t('addReference')}
          </Button>
        </div>
      </section>

      {items.length === 0 ? (
        <p className="surface-card p-8 text-sm text-muted">{t('noReferences')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const verified = item.verification === 'USER_CONFIRMED';
            const busy = busyId === item.id;

            return (
              <li key={item.id} className="surface-card flex flex-col gap-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <p dir="auto" className="text-sm leading-relaxed text-ink">
                    {item.formatted || item.rawText}
                  </p>
                  <Badge tone={verified ? 'success' : 'warning'}>
                    {verified ? (
                      <Check className="size-3" aria-hidden />
                    ) : (
                      <AlertTriangle className="size-3" aria-hidden />
                    )}
                    {verified ? t('confirmed') : t('unverified')}
                  </Badge>
                </div>

                {item.formatted && item.formatted !== item.rawText ? (
                  <p dir="auto" className="border-s-2 border-line ps-3 text-xs text-muted">
                    {item.rawText}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => patch(item.id, { action: 'format', style })}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Wand2 className="size-3.5" aria-hidden />
                    )}
                    {t('formatWith')}
                  </Button>

                  {!verified ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => patch(item.id, { action: 'verify' })}
                      disabled={busy}
                    >
                      <Check className="size-3.5" aria-hidden />
                      {t('markVerified')}
                    </Button>
                  ) : null}

                  <a
                    href={`https://scholar.google.com/scholar?q=${encodeURIComponent(item.rawText.slice(0, 200))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-muted transition-colors hover:text-ink"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t('searchScholar')}
                  </a>

                  <Button
                    size="sm"
                    variant="ghost"
                    className="ms-auto text-danger"
                    onClick={() => remove(item.id)}
                    disabled={busy}
                    aria-label={tc('delete')}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('deleteReference')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
