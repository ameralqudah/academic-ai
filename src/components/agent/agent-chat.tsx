'use client';

import { ArrowUp, Check, FileSpreadsheet, Loader2, Paperclip, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { ProjectPicker, type ProjectOption } from '@/components/agent/project-picker';
import { ResultCard, type StatisticalResult } from '@/components/agent/result-card';
import { SourceList, type RetrievedSource, type SourceCoverage } from '@/components/agent/source-list';
import { Markdown } from '@/components/chat/markdown';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * The agent conversation.
 *
 * The shape of this component follows from one property of the thing it talks
 * to: an agent task has stages, and the stages take seconds. A panel that shows
 * nothing until the answer arrives leaves the user unable to tell thinking from
 * stuck, so every stage is drawn as it starts and ticked as it finishes.
 *
 * Results arrive as objects, not as rendered text. That is what lets the table
 * be a real table — sortable, exportable, attachable to a chapter later —
 * rather than a paragraph describing one, and it is why the transport carries
 * `result` events alongside `delta`.
 */

/**
 * Reads the human message out of an error envelope.
 *
 * The API sends both a fallback sentence and, where one exists, a `reasonKey`
 * with its parameters. The key is what should be shown: the fallback is
 * English-only, and for parse failures it is the key itself — which is how a
 * user came to see the literal string "analysis.error.notAWorkbook" on screen
 * after uploading a file with the wrong extension. The refusal was right and
 * the message was a code.
 */
function errorMessage(
  json: { error?: { message?: string; details?: { reasonKey?: string; params?: Record<string, string | number> } } },
  fallback: (key: string) => string,
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  const reasonKey = json?.error?.details?.reasonKey;

  if (reasonKey) {
    try {
      return translate(reasonKey, json.error?.details?.params ?? {});
    } catch {
      // An untranslated key must not replace the message with a crash.
    }
  }

  return json?.error?.message ?? fallback('generic');
}

/**
 * Turns a code into a translation key.
 *
 * next-intl reads a dot as nesting, so a message key literally named
 * "stats.reliability" can never be resolved — the lookup goes looking for a
 * `stats` object with a `reliability` inside it, finds nothing, and renders the
 * raw key back to the user. Which is exactly what happened: a correct refusal
 * arrived with "agent.intent.stats.reliability" where the Arabic name should
 * have been. Underscores carry no meaning to the resolver, so the code is
 * flattened before lookup and the message files match.
 */
const mkey = (code: string) => code.replace(/\./g, '_');

type Role = 'user' | 'assistant';

interface Stage {
  id: string;
  labelKey: string;
  status: 'running' | 'done' | 'failed';
}

interface Turn {
  id: string;
  role: Role;
  text?: string;
  understanding?: { intent: string; restatement: string; confidence: number };
  stages?: Stage[];
  results?: { kind: string; runId?: string; payload: unknown }[];
  question?: string;
  unavailable?: { intent: string; reasonKey: string; alternatives: string[] };
  units?: number;
}

interface AttachedFile {
  datasetId: string;
  name: string;
  rows: number;
  columns: number;
}

export function AgentChat({
  locale,
  projects,
  initialProjectId,
  initialDraft,
}: {
  locale: 'ar' | 'en';
  projects: ProjectOption[];
  /**
   * Pre-selected project, read from the URL by the page.
   *
   * This is what makes the planned shortcut from inside a project a link rather
   * than a rebuild: `/ar/chat?project=abc` opens the assistant already pointed
   * at that project, and nothing here needs to know where the link came from.
   */
  initialProjectId?: string | null;
  /** Seeded from a sidebar entry — a phrase to start from, not a sent message. */
  initialDraft?: string;
}) {
  const t = useTranslations('agent');
  const te = useTranslations('errors');
  const ta = useTranslations();

  const [projectId, setProjectId] = useState<string | null>(
    initialProjectId && projects.some((project) => project.id === initialProjectId)
      ? initialProjectId
      : null,
  );
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<AttachedFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  /* ------------------------------- upload -------------------------------- */

  async function upload(selected: File) {
    setError(null);
    setUploading(true);

    try {
      const form = new FormData();
      form.append('file', selected);
      // A file uploaded while a project is selected belongs to that project.
      if (projectId) form.append('projectId', projectId);

      const response = await fetch('/api/datasets', { method: 'POST', body: form });
      const json = await response.json();

      if (!response.ok || !json.ok) {
        setError(errorMessage(json, te, ta));
        return;
      }

      setFile({
        datasetId: json.data.dataset.id,
        name: json.data.dataset.originalName,
        rows: json.data.profile.rowCount,
        columns: json.data.profile.columnCount,
      });

      /*
       * The upload is announced as its own turn rather than folded into the
       * next message. The file is a thing that now exists in the conversation
       * and will be referred to by later questions, so it deserves to be
       * visible in the history rather than implied.
       */
      setTurns((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: t('fileReady', {
            name: json.data.dataset.originalName,
            rows: json.data.profile.rowCount,
            columns: json.data.profile.columnCount,
          }),
        },
      ]);
    } catch {
      setError(te('network'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /* --------------------------------- send -------------------------------- */

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setError(null);
    setDraft('');
    setBusy(true);

    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', text: trimmed };
    const agentTurn: Turn = { id: crypto.randomUUID(), role: 'assistant', stages: [], results: [] };
    setTurns((current) => [...current, userTurn, agentTurn]);

    /* Only the last few turns travel, and only their text. */
    const history = turns
      .filter((turn) => typeof turn.text === 'string')
      .slice(-6)
      .map((turn) => ({ role: turn.role, content: turn.text as string }));

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          locale,
          datasetId: file?.datasetId,
          projectId: projectId ?? undefined,
          history,
        }),
      });

      if (!response.ok || !response.body) {
        setError(te('generic'));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const patch = (fn: (turn: Turn) => Turn) =>
        setTurns((current) => current.map((turn) => (turn.id === agentTurn.id ? fn(turn) : turn)));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          switch (event.type) {
            case 'understanding':
              patch((turn) => ({
                ...turn,
                understanding: {
                  intent: event.intent as string,
                  restatement: event.restatement as string,
                  confidence: event.confidence as number,
                },
              }));
              break;

            case 'plan':
              patch((turn) => ({
                ...turn,
                stages: (event.steps as { id: string; labelKey: string }[]).map((step) => ({
                  ...step,
                  status: 'running' as const,
                })),
                units: event.estimatedUnits as number,
              }));
              break;

            case 'step':
              patch((turn) => ({
                ...turn,
                stages: (turn.stages ?? []).map((stage) =>
                  stage.id === event.id
                    ? { ...stage, status: event.status as Stage['status'] }
                    : stage,
                ),
              }));
              break;

            case 'result':
              patch((turn) => ({
                ...turn,
                results: [
                  ...(turn.results ?? []),
                  {
                    kind: event.kind as string,
                    runId: event.runId as string | undefined,
                    payload: event.payload,
                  },
                ],
              }));
              break;

            case 'question':
              patch((turn) => ({ ...turn, question: event.question as string }));
              break;

            case 'unavailable':
              patch((turn) => ({
                ...turn,
                unavailable: {
                  intent: event.intent as string,
                  reasonKey: event.reasonKey as string,
                  alternatives: (event.alternatives as string[]) ?? [],
                },
              }));
              break;

            case 'delta':
              patch((turn) => ({ ...turn, text: (turn.text ?? '') + (event.text as string) }));
              break;

            case 'error':
              setError((event.message as string) || te('generic'));
              break;

            default:
              break;
          }
        }
      }
    } catch {
      setError(te('network'));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(submission: FormEvent) {
    submission.preventDefault();
    void send(draft);
  }

  /* -------------------------------- render ------------------------------- */

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-2">
        <ProjectPicker
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          locale={locale}
          disabled={busy}
        />
        {projectId && <span className="text-xs text-muted">{t('projectContextOn')}</span>}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {turns.length === 0 ? (
          <Welcome onPick={(text) => void send(text)} />
        ) : (
          <div className="flex flex-col gap-6 pb-4">
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} />
            ))}
          </div>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {file && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2 text-sm">
          <FileSpreadsheet className="size-4 shrink-0 text-muted" />
          <span className="truncate text-ink">{file.name}</span>
          <span className="shrink-0 text-xs text-muted">
            {t('fileSummary', { rows: file.rows, columns: file.columns })}
          </span>
          <button
            type="button"
            onClick={() => setFile(null)}
            className="ms-auto shrink-0 rounded p-1 text-muted hover:text-ink"
            aria-label={t('detachFile')}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.xlsx"
          className="hidden"
          onChange={(change) => {
            const selected = change.target.files?.[0];
            if (selected) void upload(selected);
          }}
        />

        <Button
          type="button"
          variant="ghost"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || busy}
          aria-label={t('attachFile')}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
        </Button>

        <textarea
          value={draft}
          onChange={(change) => setDraft(change.target.value)}
          onKeyDown={(key) => {
            if (key.key === 'Enter' && !key.shiftKey) {
              key.preventDefault();
              void send(draft);
            }
          }}
          rows={1}
          placeholder={t('placeholder')}
          disabled={busy}
          className="min-h-11 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-60"
        />

        <Button type="submit" disabled={busy || draft.trim().length === 0}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </Button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Pieces                                    */
/* -------------------------------------------------------------------------- */

function TurnView({ turn }: { turn: Turn }) {
  const t = useTranslations('agent');

  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-4 py-2.5 text-sm text-on-accent">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {turn.understanding && (
        <p className="text-sm text-muted">{turn.understanding.restatement}</p>
      )}

      {/* Stages, drawn as they run — the answer to "is it stuck or working". */}
      {turn.stages && turn.stages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {turn.stages.map((stage) => (
            <div key={stage.id} className="flex items-center gap-2 text-xs">
              {stage.status === 'running' && <Loader2 className="size-3.5 animate-spin text-muted" />}
              {stage.status === 'done' && <Check className="size-3.5 text-success" />}
              {stage.status === 'failed' && <X className="size-3.5 text-danger" />}
              <span className={stage.status === 'done' ? 'text-muted' : 'text-ink'}>
                {t(mkey(stage.labelKey.replace('agent.', '')))}
              </span>
            </div>
          ))}
        </div>
      )}

      {turn.results?.map((result, index) => (
        <ResultView key={index} kind={result.kind} payload={result.payload} />
      ))}

      {/*
        A recognised request the product cannot serve. Its own presentation
        rather than an error, because the request was understood — declining it
        by name teaches the user what the tool does, where a generic failure
        teaches nothing.
      */}
      {turn.unavailable && (
        <Alert tone="warning">
          <div className="flex flex-col gap-2">
            <span>{t(unavailableKey(turn.unavailable.reasonKey))}</span>
            {turn.unavailable.alternatives.length > 0 && (
              <span className="text-xs">
                {t('alternatives')}:{' '}
                {turn.unavailable.alternatives.map((alt) => t(`intent.${mkey(alt)}`)).join('، ')}
              </span>
            )}
          </div>
        </Alert>
      )}

      {turn.question && (
        <div className="rounded-xl border border-line bg-subtle px-4 py-3 text-sm text-ink">
          {turn.question}
        </div>
      )}

      {turn.text && <Markdown content={turn.text} compact />}
    </div>
  );
}

/**
 * `agent.unavailable.plsSem` is genuinely nested and resolves as it is.
 * `agent.unavailable.test.nonparametric.mannWhitney` is not: everything after
 * `test.` is one key naming a test, so only that tail is flattened.
 */
function unavailableKey(reasonKey: string): string {
  const stripped = reasonKey.replace('agent.', '');
  const marker = 'unavailable.test.';
  if (stripped.startsWith(marker)) {
    return `${marker}${mkey(stripped.slice(marker.length))}`;
  }
  return stripped;
}

function ResultView({ kind, payload }: { kind: string; payload: unknown }) {
  const t = useTranslations('agent');

  if (kind === 'analysis' || kind === 'reliability') {
    return <ResultCard result={payload as StatisticalResult} />;
  }

  if (kind === 'literature') {
    const found = payload as { sources: RetrievedSource[]; coverage: SourceCoverage };
    return <SourceList sources={found.sources} coverage={found.coverage} />;
  }

  if (kind === 'profile') {
    const profile = payload as {
      rowCount: number;
      columnCount: number;
      columns: { name: string; type: string; scale: string; missing: number }[];
    };

    return (
      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="mb-3 text-xs text-muted">
          {t('profileSummary', { rows: profile.rowCount, columns: profile.columnCount })}
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="py-1.5 text-start font-medium">{t('table.column')}</th>
              <th className="py-1.5 text-start font-medium">{t('table.type')}</th>
              <th className="py-1.5 text-start font-medium">{t('table.scale')}</th>
              <th className="py-1.5 text-end font-medium">{t('table.missing')}</th>
            </tr>
          </thead>
          <tbody>
            {profile.columns.map((column) => (
              <tr key={column.name} className="border-b border-line/50 last:border-0">
                <td className="py-1.5 font-mono text-ink">{column.name}</td>
                <td className="py-1.5 text-muted">{t(`type.${column.type}`)}</td>
                <td className="py-1.5 text-muted">{t(`scale.${column.scale}`)}</td>
                <td className="py-1.5 text-end font-mono text-muted">{column.missing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (kind === 'recommendation') {
    const recommendation = payload as {
      best: { test: string } | null;
      candidates: { test: string; confidence: string; available: boolean }[];
    };

    return (
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <span className="text-xs font-medium text-muted">{t('recommendedTests')}</span>
        {recommendation.candidates.slice(0, 4).map((candidate) => (
          <div key={candidate.test} className="flex items-center gap-2 text-sm">
            <span className={candidate.available ? 'text-ink' : 'text-muted line-through'}>
              {t(`test.${mkey(candidate.test)}`)}
            </span>
            <span className="text-xs text-muted">{t(`confidence.${candidate.confidence}`)}</span>
            {!candidate.available && (
              <span className="rounded bg-subtle px-1.5 py-0.5 text-xs text-muted">
                {t('notBuiltYet')}
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const t = useTranslations('agent');

  const examples = ['exampleAnalyse', 'exampleReliability', 'exampleClean', 'examplePlan'] as const;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 py-12 text-center">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-ink">{t('welcome')}</h2>
        <p className="max-w-md text-sm text-muted">{t('welcomeSubtitle')}</p>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        {examples.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onPick(t(key))}
            className={cn(
              'rounded-full border border-line px-3.5 py-1.5 text-sm text-muted',
              'hover:border-accent hover:text-ink',
            )}
          >
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
}
