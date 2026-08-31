'use client';

import { Check, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Composer, type ModeKey, type ModeOption, type ModelOption } from '@/components/agent/composer';
import { ProjectPicker, type ProjectOption } from '@/components/agent/project-picker';
import { MessageActions, MessageEditor } from '@/components/agent/message-actions';
import {
  RolePicker,
  type ColumnSummary,
  type RoleAssignment,
} from '@/components/agent/role-picker';
import { ResultCard, type StatisticalResult } from '@/components/agent/result-card';
import { SourceList, type RetrievedSource, type SourceCoverage } from '@/components/agent/source-list';
import { Markdown } from '@/components/chat/markdown';
import { Alert } from '@/components/ui/alert';
import { useRouter } from '@/i18n/navigation';
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
 * Whether a question from the agent is asking which variable does what.
 *
 * Matched on phrases rather than on a flag from the server, which is the weaker
 * of the two designs and deliberately chosen for now: adding a structured
 * `needsRoles` event would mean changing the orchestrator, the event union and
 * the persisted payload, and the phrases the agent uses for this are fixed
 * strings in two languages rather than model output. When the agent grows more
 * ways to ask, this should become an event.
 */
function needsRoles(question: string): boolean {
  return (
    /which variable is the outcome/i.test(question) ||
    /roles first/i.test(question) ||
    /which scale items/i.test(question) ||
    question.includes('أي متغيّر هو التابع') ||
    question.includes('تحديد الأدوار') ||
    question.includes('أي بنود المقياس')
  );
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
  /** The request this answers, so a restatement of it can be suppressed. */
  userMessage?: string;
  /** An attachment notice, replaced by the next upload rather than accumulating. */
  isUploadNotice?: boolean;
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
  /**
   * The column list, kept so roles can be assigned without another request.
   *
   * The upload response already carries the profile; discarding it and asking
   * again when the agent wants roles would be a round trip for data the client
   * had and threw away.
   */
  fields: ColumnSummary[];
}

export function AgentChat({
  locale,
  projects,
  initialProjectId,
  initialDraft,
  conversationId: initialConversationId,
  initialTurns,
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
  /** An existing conversation, loaded by the page from `?c=`. */
  conversationId?: string | null;
  /** Its saved turns, so a refresh returns to the thread rather than an empty page. */
  initialTurns?: Turn[];
}) {
  const t = useTranslations('agent');
  const te = useTranslations('errors');

  const [projectId, setProjectId] = useState<string | null>(
    initialProjectId && projects.some((project) => project.id === initialProjectId)
      ? initialProjectId
      : null,
  );
  const [turns, setTurns] = useState<Turn[]>(initialTurns ?? []);
  /*
   * Null until the first message, when the server creates the conversation and
   * sends its id back. Held here so every later turn in this session joins the
   * same thread instead of starting a new one.
   */
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<AttachedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ModeKey>('chat');
  /*
   * Set when the agent asks for variable roles. Holding the question that
   * prompted it means confirming can resend the original request with the
   * roles attached, rather than making the user retype it.
   */
  const [rolePrompt, setRolePrompt] = useState<{ message: string } | null>(null);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  /** The message being rewritten, if any. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<{
    modes: ModeOption[];
    models: ModelOption[];
    showModelSelector: boolean;
  }>({ modes: [], models: [], showModelSelector: false });

  /*
   * Held so the stop button can actually stop something. Without a controller
   * the only way out of a long response is reloading the page, and the request
   * carries on server-side regardless.
   */
  const abortRef = useRef<AbortController | null>(null);

  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  /*
   * Modes and permitted models come from the server, because which models a
   * user may pick is a fact about their plan and not something the client can
   * work out. The same endpoint is the one that enforces it.
   */
  useEffect(() => {
    let cancelled = false;

    void fetch('/api/agent')
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (cancelled || !json?.ok) return;
        setCapabilities({
          modes: json.data.modes ?? [],
          models: json.data.models ?? [],
          showModelSelector: Boolean(json.data.showModelSelector),
        });
        setModelId(json.data.models?.find((m: ModelOption) => m.isDefault)?.id ?? null);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  /* Ctrl/⌘+K starts a new conversation, the one shortcut worth a global handler. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        /*
         * A client navigation rather than a location assignment: a full page
         * load would discard the React tree and re-fetch everything to reach a
         * route the router already knows about.
         */
        router.push('/chat');
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);

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
        /*
         * The server sends a finished sentence in both languages, so the
         * client picks one rather than looking anything up. Translating in the
         * browser is what put `analysis.error.notAWorkbook` on screen: the
         * lookup returned the key instead of throwing, so the fallback never
         * ran and the failure was silent.
         */
        setError(
          (locale === 'ar' ? json?.error?.messageAr : json?.error?.message) ?? te('generic'),
        );
        return;
      }

      /*
       * A previous failure is no longer true once a file has been read. It was
       * staying on screen underneath the success line, so the page showed a
       * refusal and an accepted file at the same time.
       */
      setError(null);

      setFile({
        datasetId: json.data.dataset.id,
        name: json.data.dataset.originalName,
        rows: json.data.profile.rowCount,
        columns: json.data.profile.columnCount,
        fields: (json.data.profile.columns ?? []).map(
          (column: {
            name: string;
            type: string;
            scale: string;
            missing: number;
            distinct: number;
          }) => ({
            name: column.name,
            type: column.type,
            scale: column.scale,
            missing: column.missing,
            distinct: column.distinct,
          }),
        ),
      });

      /*
       * The upload is announced as its own turn rather than folded into the
       * next message. The file is a thing that now exists in the conversation
       * and will be referred to by later questions, so it deserves to be
       * visible in the history rather than implied.
       */
      /*
       * Replaces any previous upload notice rather than appending one.
       *
       * Re-uploading — after a failure, or to swap the file — was leaving a
       * trail of identical "file ready" lines, each describing a file that was
       * no longer the attached one. Only the current attachment is true, so
       * only it is shown.
       */
      setTurns((current) => [
        ...current.filter((turn) => !turn.isUploadNotice),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          isUploadNotice: true,
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
    const agentTurn: Turn = {
      id: crypto.randomUUID(),
      role: 'assistant',
      stages: [],
      results: [],
      userMessage: trimmed,
    };
    setTurns((current) => [...current, userTurn, agentTurn]);

    /* Only the last few turns travel, and only their text. */
    const history = turns
      .filter((turn) => typeof turn.text === 'string')
      .slice(-6)
      .map((turn) => ({ role: turn.role, content: turn.text as string }));

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const response = await fetch('/api/agent', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          locale,
          datasetId: file?.datasetId,
          projectId: projectId ?? undefined,
          conversationId: conversationId ?? undefined,
          mode,
          modelId: modelId ?? undefined,
          roles: roles.length > 0 ? roles : undefined,
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
            case 'conversation': {
              const id = event.conversationId as string;
              setConversationId(id);
              /*
               * The URL follows the conversation, so a refresh mid-answer
               * returns here rather than to a blank page — and the address bar
               * becomes something the user can bookmark or share with
               * themselves. `replaceState` rather than a router push: this is
               * the same page, and a history entry per message would make the
               * back button useless.
               */
              if (typeof window !== 'undefined' && !conversationId) {
                const url = new URL(window.location.href);
                url.searchParams.set('c', id);
                window.history.replaceState(null, '', url.toString());
              }
              break;
            }

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

            case 'question': {
              const question = event.question as string;
              patch((turn) => ({ ...turn, question }));

              /*
               * A question about variable roles opens the picker rather than
               * sitting there as text. The agent is right to refuse to guess
               * which variable is the outcome — that decision is what the study
               * is about — but a user with two hundred columns cannot answer in
               * prose, and until now that refusal was a dead end.
               */
              if (file && needsRoles(question)) {
                setRoles([]);
                setRolePrompt({ message: trimmed });
              }
              break;
            }

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
    } catch (caught) {
      /*
       * An abort is the user pressing stop, not a failure. Reporting it as a
       * network error would tell them something went wrong when they were the
       * one who ended it.
       */
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(te('network'));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  /**
   * Rewrites a message and asks again from that point.
   *
   * The server creates a sibling rather than overwriting, so the original and
   * everything after it survive on an inactive branch. What the user sees is
   * the thread rebuilt from the edit onward.
   */
  async function editMessage(messageId: string, content: string) {
    if (!conversationId) return;
    setEditingId(null);

    try {
      const response = await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'editMessage', messageId, content }),
      });

      const json = await response.json();
      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? te('generic'));
        return;
      }

      /*
       * Everything from the edited message onward is dropped locally before the
       * new request goes out. Those turns answered a question that is no longer
       * being asked, and leaving them on screen while a new answer streams in
       * below would show two conversations at once.
       */
      setTurns((current) => {
        const index = current.findIndex((turn) => turn.id === messageId);
        return index >= 0 ? current.slice(0, index) : current;
      });

      void send(content);
    } catch {
      setError(te('network'));
    }
  }

  /**
   * Asks the same question again.
   *
   * The route detaches the old answer and hands back the question; sending it
   * through the ordinary path means a regenerated reply goes through exactly
   * the same agent as any other and cannot drift from it.
   */
  async function regenerate(messageId: string) {
    if (!conversationId) return;

    try {
      const response = await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'regenerate', messageId }),
      });

      const json = await response.json();
      if (!response.ok || !json.ok) {
        setError(json?.error?.message ?? te('generic'));
        return;
      }

      setTurns((current) => {
        const index = current.findIndex((turn) => turn.id === messageId);
        return index >= 0 ? current.slice(0, index) : current;
      });

      void send(json.data.prompt as string);
    } catch {
      setError(te('network'));
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
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
              <TurnView
                key={turn.id}
                turn={turn}
                editing={editingId === turn.id}
                onStartEdit={() => setEditingId(turn.id)}
                onCancelEdit={() => setEditingId(null)}
                onSubmitEdit={(value) => void editMessage(turn.id, value)}
                onRegenerate={() => void regenerate(turn.id)}
              />
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

      {/*
        The picker sits above the composer rather than inside the transcript.
        
        A panel with two hundred rows placed mid-conversation would push the
        question that prompted it off the screen, and scrolling back to read it
        while choosing is exactly the friction this is meant to remove.
      */}
      {rolePrompt && file && (
        <RolePicker
          columns={file.fields}
          value={roles}
          onChange={setRoles}
          onCancel={() => {
            setRolePrompt(null);
            setRoles([]);
          }}
          onConfirm={() => {
            const original = rolePrompt.message;
            setRolePrompt(null);
            /* Resends the request that was asked, now carrying the answer. */
            void send(original);
          }}
        />
      )}

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={(text) => void send(text)}
        onStop={stop}
        onAttach={(selected) => void upload(selected)}
        busy={busy}
        uploading={uploading}
        modes={capabilities.modes}
        mode={mode}
        onModeChange={setMode}
        models={capabilities.models}
        modelId={modelId}
        onModelChange={setModelId}
        showModelSelector={capabilities.showModelSelector}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Pieces                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a restatement says anything the request did not.
 *
 * Compared on normalised words rather than exact text, because "I want studies
 * on cooperative learning" and "You want studies about cooperative learning"
 * are the same sentence with the pronouns turned around. Anything sharing most
 * of its words with the request is treated as an echo.
 */
function addsMeaning(restatement: string, userMessage?: string): boolean {
  if (!restatement.trim()) return false;
  if (!userMessage) return true;

  const normalise = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2),
    );

  const said = normalise(userMessage);
  const restated = normalise(restatement);
  if (restated.size === 0) return false;

  let shared = 0;
  for (const word of restated) if (said.has(word)) shared += 1;

  return shared / restated.size < 0.7;
}

function TurnView({
  turn,
  editing,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
}: {
  turn: Turn;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (value: string) => void;
  onRegenerate: () => void;
}) {
  const t = useTranslations('agent');

  if (turn.role === 'user') {
    /* Editing takes over the bubble, so the thread around it stays readable. */
    if (editing) {
      return (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%]">
            <MessageEditor
              initialValue={turn.text ?? ''}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl bg-accent px-4 py-2.5 text-sm text-on-accent">
          {turn.text}
        </div>
        <MessageActions role="user" content={turn.text ?? ''} onEdit={onStartEdit} />
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-3">
      {/*
        The agent's reading of the request, shown only when it adds something.
        
        For a plain question the restatement is the question again, and printing
        it puts the user's own words on screen twice — once in their bubble and
        once as the assistant apparently repeating them. It earns its place when
        the agent interpreted something: picked columns, narrowed a topic,
        resolved an ambiguity.
      */}
      {turn.understanding && addsMeaning(turn.understanding.restatement, turn.userMessage) && (
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

      {/*
        Only once the reply is complete. Offering "regenerate" mid-stream would
        invite a click that races the answer still arriving.
      */}
      {turn.text && !turn.stages?.some((stage) => stage.status === 'running') && (
        <MessageActions role="assistant" content={turn.text} onRegenerate={onRegenerate} />
      )}
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
