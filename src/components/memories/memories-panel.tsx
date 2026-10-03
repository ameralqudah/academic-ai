'use client';

import { Archive, Check, Loader2, Pencil, Pin, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select, TextArea } from '@/components/ui/field';

/*
 * "What Academic AI remembers" (P1-E). One panel for the user's own memories
 * (settings) and a project's (the project's memories page). It shows what the
 * server returned and offers only what the server marked `editable`; the API
 * decides every action again, and the database once more.
 */

export interface MemoryItem {
  id: string;
  kind: string;
  content: string;
  status: 'proposed' | 'confirmed' | 'archived';
  pinned: boolean;
  editable: boolean;
  proposedBy: { runId: string } | null;
}

const KINDS = ['preference', 'fact', 'instruction', 'style', 'decision'] as const;
type Kind = (typeof KINDS)[number];

export function MemoriesPanel({
  endpoint,
  locale,
  initial,
  canAdd,
  title,
  intro,
  readOnlyNote,
}: {
  /** `/api/v1/me/memories` or `/api/v1/projects/:id/memories`. */
  endpoint: string;
  locale: 'ar' | 'en';
  initial: MemoryItem[];
  canAdd: boolean;
  title: string;
  intro: string;
  readOnlyNote?: boolean;
}) {
  const t = useTranslations('memories');
  const [items, setItems] = useState<MemoryItem[]>(initial);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<Kind>('preference');
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, init: RequestInit): Promise<{ memory?: MemoryItem } | null> {
    setError(null);
    const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const body = (await response.json().catch(() => null)) as { data?: { memory?: MemoryItem }; error?: { message?: string; messageAr?: string } } | null;
    if (!response.ok) {
      setError((locale === 'ar' ? body?.error?.messageAr : body?.error?.message) ?? t('error'));
      return null;
    }
    return body?.data ?? {};
  }

  const replace = (memory: MemoryItem) => setItems((current) => current.map((item) => (item.id === memory.id ? memory : item)));

  async function add() {
    if (!content.trim()) return;
    setBusy('new');
    try {
      const result = await call(endpoint, { method: 'POST', body: JSON.stringify({ kind, content: content.trim(), pinned }) });
      if (result?.memory) {
        setItems((current) => [result.memory!, ...current]);
        setContent('');
        setPinned(false);
      }
    } finally {
      setBusy(null);
    }
  }

  async function act(item: MemoryItem, action: 'confirm' | 'archive') {
    setBusy(item.id);
    try {
      const result = await call(`${endpoint}/${item.id}/${action}`, { method: 'POST' });
      if (result?.memory) replace(result.memory);
    } finally {
      setBusy(null);
    }
  }

  async function save(item: MemoryItem, patch: { content?: string; pinned?: boolean }) {
    setBusy(item.id);
    try {
      const result = await call(`${endpoint}/${item.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (result?.memory) {
        replace(result.memory);
        setEditing(null);
      }
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: MemoryItem) {
    if (!window.confirm(t('deleteConfirm'))) return;
    setBusy(item.id);
    try {
      const result = await call(`${endpoint}/${item.id}`, { method: 'DELETE' });
      if (result) setItems((current) => current.filter((entry) => entry.id !== item.id));
    } finally {
      setBusy(null);
    }
  }

  const groups: { status: MemoryItem['status']; label: string }[] = [
    { status: 'proposed', label: t('proposed') },
    { status: 'confirmed', label: t('confirmed') },
    { status: 'archived', label: t('archived') },
  ];

  return (
    <Card className="flex flex-col gap-5" data-testid="memories-panel">
      <CardHeader title={title} description={intro} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {readOnlyNote ? <p className="text-sm text-muted">{t('readOnly')}</p> : null}

      {canAdd ? (
        <div className="flex flex-col gap-3">
          <Field label={t('content')} htmlFor="memory-content">
            <TextArea id="memory-content" value={content} maxLength={2000} placeholder={t('contentPlaceholder')} onChange={(event) => setContent(event.target.value)} />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('kind')} htmlFor="memory-kind">
              <Select id="memory-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`kinds.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} />
              {t('pinned')}
            </label>
            <Button onClick={() => void add()} disabled={busy === 'new' || !content.trim()}>
              {busy === 'new' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {busy === 'new' ? t('saving') : t('add')}
            </Button>
          </div>
        </div>
      ) : null}

      {groups.map((group) => {
        const list = items.filter((item) => item.status === group.status);
        if (group.status !== 'confirmed' && list.length === 0) return null;
        return (
          <section key={group.status} className="flex flex-col gap-2" aria-label={group.label}>
            <h3 className="text-sm font-semibold text-ink">{group.label}</h3>
            {list.length === 0 ? <p className="text-sm text-muted">{t('none')}</p> : null}
            <ul className="flex flex-col gap-2">
              {list.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 rounded-lg border border-line p-3" data-memory-status={item.status}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={item.status === 'proposed' ? 'warning' : item.status === 'archived' ? 'neutral' : 'success'}>{t(`status.${item.status}`)}</Badge>
                    <Badge>{t.has(`kinds.${item.kind}`) ? t(`kinds.${item.kind}`) : item.kind}</Badge>
                    {item.pinned ? <Pin className="size-3.5 text-muted" aria-label={t('pinned')} /> : null}
                    {item.proposedBy ? <span className="text-xs text-muted">{t('proposedBy')}</span> : null}
                  </div>
                  {editing === item.id ? (
                    <TextArea value={draft} maxLength={2000} onChange={(event) => setDraft(event.target.value)} aria-label={t('content')} />
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-ink" dir="auto">
                      {item.content}
                    </p>
                  )}
                  {item.editable ? (
                    <div className="flex flex-wrap gap-2">
                      {editing === item.id ? (
                        <>
                          <Button size="sm" onClick={() => void save(item, { content: draft.trim() })} disabled={busy === item.id || !draft.trim()}>
                            {t('save')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            {t('cancel')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {item.status !== 'confirmed' ? (
                            <Button size="sm" onClick={() => void act(item, 'confirm')} disabled={busy === item.id}>
                              {item.status === 'proposed' ? <Check className="size-4" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
                              {item.status === 'proposed' ? t('confirm') : t('restore')}
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => { setEditing(item.id); setDraft(item.content); }} disabled={busy === item.id}>
                            <Pencil className="size-4" aria-hidden />
                            {t('edit')}
                          </Button>
                          {item.status !== 'archived' ? (
                            <Button size="sm" variant="ghost" onClick={() => void act(item, 'archive')} disabled={busy === item.id}>
                              <Archive className="size-4" aria-hidden />
                              {t('archive')}
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => void remove(item)} disabled={busy === item.id}>
                            <Trash2 className="size-4" aria-hidden />
                            {t('delete')}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}
