'use client';

import { CheckCircle2, Loader2, Save, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatPanel, type ChatMessage } from '@/components/chat/chat-panel';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TextArea } from '@/components/ui/field';
import type { SectionKey } from '@/config/research';
import { countWords } from '@/lib/text';

type SectionStatus = 'EMPTY' | 'DRAFT' | 'AI_SUGGESTED' | 'USER_EDITED' | 'APPROVED';

const AUTOSAVE_DELAY_MS = 1500;

export function SectionWorkspace({
  projectId,
  sectionKey,
  heading,
  initialContent,
  initialStatus,
  initialMessages,
  requiresUserData,
  dependents,
}: {
  projectId: string;
  sectionKey: SectionKey;
  heading: string;
  initialContent: string;
  initialStatus: SectionStatus;
  initialMessages: ChatMessage[];
  requiresUserData: boolean;
  dependents: string[];
}) {
  const t = useTranslations('wizard');
  const ts = useTranslations('sections');
  const tc = useTranslations('common');
  const te = useTranslations('errors');

  const [content, setContent] = useState(initialContent);
  const [status, setStatus] = useState<SectionStatus>(initialStatus);
  const [instruction, setInstruction] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [guardrail, setGuardrail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The unmount flush must not read `content` from a closure — an empty dep array
   * would capture the *initial* value and overwrite the user's work with it when
   * they switch sections before the debounce fires.
   */
  const latestRef = useRef(initialContent);

  const save = useCallback(
    async (value: string, nextStatus?: SectionStatus) => {
      setSaving(true);
      setError(null);

      const response = await fetch(
        `/api/projects/${projectId}/sections/${sectionKey}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: value,
            heading,
            status: nextStatus ?? (value.trim() ? 'USER_EDITED' : 'DRAFT'),
            origin: 'USER',
          }),
        },
      );

      setSaving(false);

      if (!response.ok) {
        setError(te('server'));
        return;
      }

      dirtyRef.current = false;
      setSavedAt(Date.now());
      if (nextStatus) setStatus(nextStatus);
      else if (value.trim()) setStatus('USER_EDITED');
    },
    [heading, projectId, sectionKey, te],
  );

  // Autosave: debounce writes, and flush once on unmount so a fast navigation
  // never loses the last keystrokes.
  useEffect(() => {
    latestRef.current = content;
    if (!dirtyRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(content), AUTOSAVE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [content, save]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    return () => {
      if (dirtyRef.current) void saveRef.current(latestRef.current);
    };
  }, []);

  async function generate() {
    setGenerating(true);
    setError(null);
    setGuardrail(null);

    const response = await fetch('/api/ai/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sectionKey, instruction: instruction || undefined }),
    });

    const body = (await response.json()) as
      | {
          ok: true;
          data: { content: string; guardrails: { notice: { ar: string; en: string } | null } };
        }
      | { ok: false; error: { code: string } };

    setGenerating(false);

    if (!response.ok || !body.ok) {
      const code = body.ok ? '' : body.error.code;
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

    setContent(body.data.content);
    setStatus('AI_SUGGESTED');
    dirtyRef.current = false;
    if (body.data.guardrails.notice) setGuardrail(body.data.guardrails.notice.ar);
  }

  async function approve() {
    if (dirtyRef.current) await save(content);
    setApproving(true);
    setError(null);

    const response = await fetch(`/api/projects/${projectId}/sections/${sectionKey}`, {
      method: 'POST',
    });

    setApproving(false);
    if (!response.ok) {
      setError(te('server'));
      return;
    }
    setStatus('APPROVED');
  }

  const words = countWords(content);

  return (
    <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{heading}</h2>
            <Badge tone={status === 'APPROVED' ? 'success' : status === 'EMPTY' ? 'neutral' : 'primary'}>
              {ts(`status.${status}`)}
            </Badge>
          </div>

          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="tabular">{t('wordCount', { count: words })}</span>
            {saving ? (
              <span className="flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {tc('saving')}
              </span>
            ) : savedAt ? (
              <span>{tc('saved')}</span>
            ) : null}
          </div>
        </div>

        {requiresUserData && !content.trim() ? (
          <Alert tone="warning">{t('requiresData')}</Alert>
        ) : null}
        {guardrail ? (
          <Alert tone="warning" title={t('guardrailTitle')}>
            {guardrail}
          </Alert>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {status === 'USER_EDITED' && dependents.length > 0 ? (
          <Alert tone="info">
            {t('dependentsWarning', {
              sections: dependents.map((key) => ts(key)).join('، '),
            })}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <label htmlFor="instruction" className="text-xs font-medium text-muted">
            {t('instructionLabel')}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="instruction"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              maxLength={1500}
              placeholder={t('instructionPlaceholder')}
              className="flex-1 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-primary focus:ring-2 focus:ring-primary/25 focus:outline-none"
            />
            <Button onClick={generate} disabled={generating}>
              {generating ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="size-4" aria-hidden />
              )}
              {generating ? t('generating') : content.trim() ? t('regenerate') : t('generate')}
            </Button>
          </div>
        </div>

        <TextArea
          value={content}
          onChange={(event) => {
            dirtyRef.current = true;
            setContent(event.target.value);
          }}
          placeholder={t('empty')}
          className="prose-editor min-h-[26rem] flex-1"
          dir="auto"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void save(content)} disabled={saving}>
            <Save className="size-4" aria-hidden />
            {t('save')}
          </Button>
          <Button
            variant={status === 'APPROVED' ? 'secondary' : 'primary'}
            onClick={approve}
            disabled={approving || !content.trim() || status === 'APPROVED'}
          >
            {approving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <CheckCircle2 className="size-4" aria-hidden />
            )}
            {status === 'APPROVED' ? t('approved') : t('approve')}
          </Button>
        </div>
      </section>

      <ChatPanel
        projectId={projectId}
        sectionKey={sectionKey}
        initialMessages={initialMessages}
        onInsert={(text) => {
          dirtyRef.current = true;
          setContent((current) => (current.trim() ? `${current}\n\n${text}` : text));
        }}
        className="h-[38rem] lg:sticky lg:top-6 lg:h-[calc(100dvh-6rem)]"
      />
    </div>
  );
}
