'use client';

import { Check, Copy, Loader2, Play, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Select, TextArea } from '@/components/ui/field';
import type { ToolDefinition } from '@/config/research';
import { countWords } from '@/lib/text';

export function ToolRunner({
  tool,
  projects,
}: {
  tool: ToolDefinition;
  projects: { id: string; title: string }[];
}) {
  const t = useTranslations('tools');
  const te = useTranslations('errors');
  const tu = useTranslations('usage');

  const [input, setInput] = useState('');
  const [options, setOptions] = useState<Record<string, string>>(
    Object.fromEntries((tool.options ?? []).map((option) => [option.name, option.values[0]!])),
  );
  const [projectId, setProjectId] = useState('');
  const [output, setOutput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run() {
    if (input.trim().length < 10) return;

    setRunning(true);
    setError(null);
    setNotice(null);
    setOutput('');

    const response = await fetch('/api/ai/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolKey: tool.key,
        input,
        options,
        ...(projectId ? { projectId } : {}),
      }),
    });

    const body = (await response.json()) as
      | { ok: true; data: { output: string; guardrails: { notice: { ar: string } | null } } }
      | { ok: false; error: { code: string } };

    setRunning(false);

    if (!response.ok || !body.ok) {
      const code = body.ok ? '' : body.error.code;
      if (code === 'PLAN_LIMIT') setLimit(true);
      else if (code === 'AI_UNAVAILABLE') setError(te('aiUnavailable'));
      else if (code === 'RATE_LIMITED') setError(te('rateLimited'));
      else setError(te('server'));
      return;
    }

    setOutput(body.data.output);
    if (body.data.guardrails.notice) setNotice(body.data.guardrails.notice.ar);
  }

  async function copy() {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (limit) {
    return (
      <Alert tone="upgrade" title={tu('limitReachedTitle')}>
        {tu('limitReachedBody')}
      </Alert>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="surface-card flex flex-col gap-4 p-5">
        {(tool.options ?? []).map((option) => (
          <Field key={option.name} label={t(`options.${option.name}`)} htmlFor={option.name}>
            <Select
              id={option.name}
              value={options[option.name]}
              onChange={(event) =>
                setOptions((current) => ({ ...current, [option.name]: event.target.value }))
              }
            >
              {option.values.map((value) => (
                <option key={value} value={value}>
                  {t(`options.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        ))}

        {projects.length > 0 ? (
          <Field label={t('attachProject')} htmlFor="projectId">
            <Select
              id="projectId"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{t('noProject')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label={t('inputLabel')} htmlFor="tool-input">
          <TextArea
            id="tool-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            rows={14}
            maxLength={20_000}
            dir="auto"
            placeholder={t('inputPlaceholder')}
            className="min-h-[18rem]"
          />
        </Field>

        <div className="flex items-center justify-between gap-3">
          <span className="tabular text-xs text-muted">{countWords(input)}</span>
          <div className="flex gap-2">
            {input ? (
              <Button variant="ghost" size="sm" onClick={() => setInput('')} disabled={running}>
                <X className="size-4" aria-hidden />
                {t('clear')}
              </Button>
            ) : null}
            <Button onClick={run} disabled={running || input.trim().length < 10}>
              {running ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Play className="size-4" aria-hidden />
              )}
              {running ? t('running') : t('run')}
            </Button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {notice ? (
          <Alert tone="warning" title={t('guardrailTitle')}>
            {notice}
          </Alert>
        ) : null}

        <div className="surface-card flex min-h-[24rem] flex-col">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">{t('output')}</h2>
            {output ? (
              <Button variant="ghost" size="sm" onClick={copy}>
                {copied ? (
                  <Check className="size-3.5 text-success" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied ? t('copied') : t('copy')}
              </Button>
            ) : null}
          </div>

          <div
            dir="auto"
            className="scrollbar-slim prose-editor flex-1 overflow-y-auto px-4 py-4 text-sm whitespace-pre-wrap text-ink-soft"
          >
            {output || <span className="text-muted">—</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
