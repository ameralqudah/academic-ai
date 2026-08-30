'use client';

import { ArrowUp, CornerDownLeft, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Markdown } from '@/components/chat/markdown';
import { Button } from '@/components/ui/button';
import type { SectionKey } from '@/config/research';
import { cn } from '@/lib/cn';

export interface ChatMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  flags?: string[];
}

const SUGGESTION_KEYS = [
  'writeProblem',
  'rewrite',
  'natural',
  'expand',
  'shorten',
  'translate',
] as const;

export function ChatPanel({
  projectId,
  sectionKey,
  initialMessages,
  onInsert,
  className,
}: {
  projectId: string;
  sectionKey?: SectionKey;
  initialMessages: ChatMessage[];
  onInsert?: (text: string) => void;
  className?: string;
}) {
  const t = useTranslations('wizard');
  const te = useTranslations('errors');

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingText, setPendingText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pendingText]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    setError(null);
    setNotice(null);
    setDraft('');
    setMessages((current) => [
      ...current,
      { id: `local-${current.length}`, role: 'USER', content: trimmed },
    ]);
    setStreaming(true);
    setPendingText('');

    let accumulated = '';

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, message: trimmed, sectionKey }),
      });

      if (!response.ok || !response.body) {
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
        setStreaming(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          const event = JSON.parse(payload) as {
            type: 'delta' | 'done' | 'error';
            text?: string;
            guardrails?: { en: string; ar: string } | null;
          };

          if (event.type === 'delta' && event.text) {
            accumulated += event.text;
            setPendingText(accumulated);
          } else if (event.type === 'done') {
            if (event.guardrails) setNotice(event.guardrails.ar);
          } else if (event.type === 'error') {
            setError(te('aiUnavailable'));
          }
        }
      }

      if (accumulated) {
        setMessages((current) => [
          ...current,
          { id: `assistant-${current.length}`, role: 'ASSISTANT', content: accumulated },
        ]);
      }
    } catch {
      setError(te('server'));
    } finally {
      setPendingText('');
      setStreaming(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  return (
    <div className={cn('surface-card flex min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{t('assistant')}</h2>
        {streaming ? (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {t('thinking')}
          </span>
        ) : null}
      </div>

      <div ref={scrollRef} className="scrollbar-slim flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !pendingText ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t('chatEmpty')}</p>
            <ul className="flex flex-col gap-1.5">
              {SUGGESTION_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => void send(t(`suggestions.${key}`))}
                    className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-start text-sm text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
                  >
                    {t(`suggestions.${key}`)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            {messages.map((message) => (
              <li key={message.id} className="flex flex-col gap-1.5">
                <span
                  className={cn(
                    'text-xs font-medium',
                    message.role === 'USER' ? 'text-muted' : 'text-accent',
                  )}
                >
                  {message.role === 'USER' ? '—' : t('assistant')}
                </span>
                <div
                  className={cn(
                    'rounded-lg px-3.5 py-2.5 text-sm leading-relaxed',
                    message.role === 'USER'
                      ? 'bg-primary-soft text-ink whitespace-pre-wrap'
                      : 'border border-line bg-surface text-ink-soft',
                  )}
                >
                  {/*
                    The user's own text is shown as typed; only the assistant's
                    is parsed as markdown. Rendering a user's message would let
                    an underscore in a variable name turn half their sentence
                    italic, and they did not ask for formatting.
                  */}
                  {message.role === 'USER' ? (
                    message.content
                  ) : (
                    <Markdown content={message.content} compact />
                  )}
                </div>
                {message.role === 'ASSISTANT' && onInsert ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    onClick={() => onInsert(message.content)}
                  >
                    <CornerDownLeft className="size-3.5" aria-hidden />
                    {t('insert')}
                  </Button>
                ) : null}
              </li>
            ))}

            {pendingText ? (
              <li className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-accent">{t('assistant')}</span>
                <div className="rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-ink-soft">
                  {/*
                    Rendered while streaming too. Half-finished markdown — an
                    unclosed fence, a table with one row so far — degrades to
                    plain text rather than breaking, so the alternative of
                    waiting for the end would only add a jump when it arrives.
                  */}
                  <Markdown content={pendingText} compact />
                </div>
              </li>
            ) : null}
          </ol>
        )}
      </div>

      {notice ? (
        <div className="px-4 pb-2">
          <Alert tone="warning" title={t('guardrailTitle')}>
            {notice}
          </Alert>
        </div>
      ) : null}
      {error ? (
        <div className="px-4 pb-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
          rows={2}
          maxLength={6000}
          disabled={streaming}
          placeholder={t('chatPlaceholder')}
          className="max-h-40 min-h-11 flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-primary focus:ring-2 focus:ring-primary/25 focus:outline-none"
        />
        <Button type="submit" size="sm" disabled={streaming || !draft.trim()} aria-label={t('send')}>
          <ArrowUp className="size-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
