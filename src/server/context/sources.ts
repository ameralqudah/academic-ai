/**
 * Where context comes from.
 *
 * Every source here reads through a repository that already exists. No new
 * table, no second copy of a conversation, no parallel notion of what a project
 * contains — the persistence layer is sound and the problem was never storage,
 * it was that nothing selected from it intelligently.
 *
 * **Absence is normal.** A task may have no project, a conversation no files, a
 * question no prior turns. Every collector returns an empty list rather than
 * throwing, because a context layer that fails when something is missing would
 * make the assistant unusable for the first message of every conversation.
 *
 * **Nothing is invented.** A missing file produces no fragment, not a
 * placeholder describing a file that is not there — a model told about a
 * dataset it cannot see will reason about columns it imagined.
 */

import { logger } from '@/lib/logger';
import * as artifactsRepo from '@/server/repositories/artifacts.repository';
import * as conversationsRepo from '@/server/repositories/conversations.repository';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import * as projectsRepo from '@/server/repositories/projects.repository';
import * as analysisRunsRepo from '@/server/repositories/analysis-runs.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import { earlierWorkIn } from '@/server/agent/earlier-work';
import type { OutputReference } from '@/server/tasks/contracts';

import { retrievePassages } from '@/server/files/retrieve';

import { fragment, type ContextFragment } from './envelope';
import { summarisePayload, summariseResult } from './result-summaries';

export interface SourceScope {
  userId: string;
  /** What was asked, so document retrieval knows what to look for. */
  request?: string;
  conversationId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  datasetId?: string | null;
  /** Instructions the caller knows about: a system prompt, a project brief. */
  instructions?: string[];
}

/**
 * Turns each source into fragments, tolerating every kind of absence.
 *
 * Collected in parallel because they are independent reads, and a context build
 * that took the sum of six queries would be felt on every message.
 */
export async function collectFragments(scope: SourceScope): Promise<ContextFragment[]> {
  const [conversation, earlier, taskResults, project, task, file, artifacts] = await Promise.all([
    conversationFragments(scope).catch(recover('conversation')),
    earlierWorkFragments(scope).catch(recover('earlier-work')),
    taskResultFragments(scope).catch(recover('task-results')),
    projectFragments(scope).catch(recover('project')),
    taskFragments(scope).catch(recover('task')),
    fileFragments(scope).catch(recover('file')),
    artifactFragments(scope).catch(recover('artifact')),
  ]);

  return [
    ...instructionFragments(scope),
    ...conversation,
    ...earlier,
    ...taskResults,
    ...project,
    ...task,
    ...file,
    ...artifacts,
  ];
}

/**
 * A failing source yields nothing rather than failing the build.
 *
 * One unreachable repository should cost its own fragments, not the whole
 * context — an assistant that cannot answer because the artifact table was slow
 * is worse than one that answers without knowing about artifacts.
 */
function recover(source: string) {
  return (error: unknown): ContextFragment[] => {
    logger.warn('context.sourceFailed', { source, error: String(error).slice(0, 200) });
    return [];
  };
}

/**
 * The user's standing instructions.
 *
 * Pinned by construction, so budgeting cannot drop them. "Always cite in APA"
 * said twenty turns ago still governs, and the old `slice(-6)` forgot it on
 * turn seven.
 */
function instructionFragments(scope: SourceScope): ContextFragment[] {
  return (scope.instructions ?? [])
    .filter((text) => text.trim().length > 0)
    .map((text, index) =>
      fragment({
        id: `instruction-${index}`,
        kind: 'instruction',
        authority: 'user-instruction',
        content: text.trim(),
        provenance: { source: 'user', id: `instruction-${index}` },
        relevance: 1,
        pinned: true,
      }),
    );
}

/**
 * Recent conversation, split by who said it.
 *
 * The user's turns and the assistant's carry different authority: what the
 * user wrote is a fact about what they want, and what the assistant wrote is a
 * draft. Merging them — as a flat message array does — is how a model's own
 * guess comes back to it as established.
 */
async function conversationFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.conversationId) return [];

  /*
   * Twenty, then scored and budgeted. Fetching more costs a larger query for
   * fragments that selection would discard; fetching fewer would hide the
   * instruction that matters.
   */
  const [messages, runs] = await Promise.all([
    conversationsRepo.listMessages(scope.conversationId, 20),
    analysisRunsRepo.listByConversation(scope.conversationId, scope.userId).catch(() => []),
  ]);

  const said = messages
    .filter((message) => typeof message.content === 'string' && message.content.trim().length > 0)
    .map((message) =>
      fragment({
        id: `message-${message.id}`,
        kind: 'conversation',
        authority: message.role === 'USER' ? 'user-content' : 'model-generated',
        content: `${message.role === 'USER' ? 'User' : 'Assistant'}: ${message.content}`,
        provenance: {
          source: 'conversation',
          id: message.id,
          at: message.createdAt?.toISOString(),
        },
      }),
    );

  /*
   * What the tools returned in this conversation.
   *
   * An analysis turn is stored as a structured payload with empty text, so the
   * filter above dropped it, and "explain these results" reached a model that
   * had never seen them. The numbers are carried as tool results — computed,
   * not written by a model — which is the authority they deserve and the one
   * the prompt tells the model it may not alter.
   */
  const seenRuns = new Set<string>();
  const computed = messages.flatMap((message) =>
    summarisePayload(message.payload).map((result, index) => {
      if (result.runId) seenRuns.add(result.runId);
      return fragment({
        id: `result-${message.id}-${index}`,
        kind: 'tool-result',
        authority: 'tool-result',
        content: result.text,
        provenance: { source: result.kind, id: result.runId ?? message.id, at: message.createdAt?.toISOString() },
        relevance: 0.85,
      });
    }),
  );

  /*
   * Runs recorded against the conversation that no message carries — an
   * analysis whose turn failed to save, or one run from another screen. The
   * run table is the record of what was computed; the messages are only one
   * way it was shown.
   */
  const unshown = runs
    .filter((run) => !seenRuns.has(run.id))
    .slice(0, 6)
    .flatMap((run) => {
      const text = summariseResult(run.testKey.startsWith('reliability') ? 'reliability' : 'analysis', run.result);
      return text
        ? [
            fragment({
              id: `run-${run.id}`,
              kind: 'tool-result',
              authority: 'tool-result',
              content: text,
              provenance: { source: `analysis:${run.testKey}`, id: run.id, at: run.createdAt?.toISOString() },
              relevance: 0.8,
            }),
          ]
        : [];
    });

  /*
   * The latest few are pinned. "Explain these results" shares no words with a
   * line of statistics, so relevance scored on overlap would rank them below
   * chatter and a tight budget could drop them — the one thing the question is
   * about. They are short; keeping four costs little.
   */
  const pinned = new Set(computed.slice(-4).map((entry) => entry.id));
  const kept = computed.map((entry) => (pinned.has(entry.id) ? { ...entry, pinned: true } : entry));

  return [...said, ...kept, ...unshown];
}

/**
 * What earlier tasks in this conversation computed and found.
 *
 * A task's results live in its steps, not in the conversation: a PLS run or a
 * literature search inside a task was visible to that task and to nothing
 * after it. The written text already travels as earlier work; this carries the
 * rest — the estimates and the sources — so the next turn can reason from them.
 */
async function taskResultFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.conversationId) return [];

  const tasks = (await tasksRepo.listForUser(scope.userId, 12)).filter(
    (task) =>
      task.conversationId === scope.conversationId &&
      task.id !== scope.taskId &&
      task.status === 'COMPLETED',
  );

  const fragments: ContextFragment[] = [];

  for (const task of tasks.slice(0, 6)) {
    for (const step of await tasksRepo.stepsOf(task.id)) {
      if (step.status !== 'COMPLETED') continue;
      const outputs = (step.output as { outputs?: OutputReference[] } | null)?.outputs ?? [];

      for (const output of outputs) {
        const kind =
          output.type === 'pls-results.v1'
            ? 'pls'
            : output.type === 'analysis.v1'
              ? ((output.data as { method?: string } | null)?.method === 'cb-sem' ? 'cbsem' : 'analysis')
              : output.type === 'sources.v1'
                ? 'literature'
                : null;
        if (!kind) continue;

        const data = (output.data ?? {}) as Record<string, unknown>;
        /* A data.analyse output carries the same display the chat renders. */
        const display = data.display as { kind?: string; payload?: unknown; runId?: string } | undefined;
        /* A computed test is stored as an analysis run, which is read above. */
        if (display?.runId) continue;
        const text = display?.kind
          ? summariseResult(display.kind, display.payload)
          : summariseResult(
              kind,
              kind === 'pls' ? { estimates: data.estimates, report: data } : kind === 'literature' ? { sources: data.references } : data,
            );
        if (!text) continue;

        fragments.push(
          fragment({
            id: `task-result-${output.id}`,
            kind: kind === 'literature' ? 'research' : 'tool-result',
            authority: kind === 'literature' ? 'external-evidence' : 'tool-result',
            content: text,
            provenance: { source: output.producedBy.capability, id: output.id, at: output.createdAt },
          }),
        );
      }
    }
  }

  return fragments.slice(0, 10);
}

/**
 * What earlier tasks in this conversation wrote.
 *
 * The conversation's own messages hold the requests and one-line restatements;
 * the papers those requests produced live in task steps. Without this, a
 * question about the paper on screen was answered by a model that had never
 * seen it.
 *
 * The most recent piece in full, within reason — six thousand characters is
 * the whole of a short paper and the opening of a long one — and the pieces
 * before it by their openings. Model-generated, because it is the assistant's
 * own draft and must not come back to it as established fact.
 */
async function earlierWorkFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.conversationId) return [];

  const works = await earlierWorkIn({
    userId: scope.userId,
    conversationId: scope.conversationId,
    excludeTaskId: scope.taskId ?? null,
    limit: 3,
  });

  return works.flatMap((work, index) => {
    const whole = index === 0;
    const text = whole ? work.text.slice(0, 6000) : work.text.slice(0, 400);
    const cut = text.length < work.text.length ? '…' : '';
    const what = work.research ? 'wrote' : 'answered';
    const title = work.heading ? ` "${work.heading}"` : '';

    const fragments = [
      fragment({
        id: `earlier-${work.outputId}`,
        kind: 'tool-result',
        authority: 'model-generated',
        content: `Earlier in this conversation the assistant ${what}${title}:\n${text}${cut}`,
        provenance: { source: work.capability, id: work.outputId, at: work.at.toISOString() },
        relevance: whole ? 0.85 : 0.5,
      }),
    ];

    if (whole && work.references.length > 0) {
      fragments.push(
        fragment({
          id: `earlier-sources-${work.outputId}`,
          kind: 'research',
          authority: 'external-evidence',
          content: `Sources that work cites, by number: ${work.references
            .slice(0, 12)
            .map((reference, position) => `[${position + 1}] ${reference.title ?? ''} (${reference.year ?? 'n.d.'})`)
            .join('; ')}`,
          provenance: { source: 'earlier-work', id: `${work.outputId}-sources`, at: work.at.toISOString() },
          relevance: 0.6,
        }),
      );
    }

    return fragments;
  });
}

/**
 * What the project holds: its question, its sections, its decisions.
 *
 * Section *titles and status*, not their bodies. A thesis section can run to
 * thousands of words, and a planner deciding what to do next needs to know that
 * a methodology chapter exists — not to read it.
 */
async function projectFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.projectId) return [];

  const project = await projectsRepo.findOwned(scope.projectId, scope.userId);
  if (!project) return [];

  const fragments: ContextFragment[] = [
    fragment({
      id: `project-${project.id}`,
      kind: 'project',
      authority: 'project-data',
      content: [
        `Project: ${project.title}`,
        project.problemArea ? `Problem area: ${project.problemArea}` : '',
        `Field: ${project.academicField}${project.specialization ? ` — ${project.specialization}` : ''}`,
        `Type: ${project.docType} (${project.degree})`,
      ]
        .filter(Boolean)
        .join('\n'),
      provenance: { source: 'project', id: project.id },
      relevance: 0.7,
    }),
  ];

  const sections = await projectsRepo.listSections(project.id);

  if (sections.length > 0) {
    fragments.push(
      fragment({
        id: `project-sections-${project.id}`,
        kind: 'project',
        authority: 'project-data',
        content: `Sections written so far: ${sections
          .map((section) => `${section.sectionKey}${section.status ? ` (${section.status})` : ''}`)
          .join(', ')}`,
        provenance: { source: 'project.sections', id: project.id },
        relevance: 0.6,
      }),
    );
  }

  return fragments;
}

/**
 * A running task's state and what its steps produced.
 *
 * Reads the typed outputs from Phase A, which is why this needs no new storage:
 * a step's result is already a first-class object with provenance attached.
 */
async function taskFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.taskId) return [];

  const task = await tasksRepo.findOwned(scope.taskId, scope.userId);
  if (!task) return [];

  const fragments: ContextFragment[] = [
    fragment({
      id: `task-${task.id}`,
      kind: 'task',
      authority: 'project-data',
      content: `Current task: ${task.request} (status: ${task.status})`,
      provenance: { source: 'task', id: task.id, at: task.createdAt?.toISOString() },
      relevance: 0.8,
    }),
  ];

  const steps = await tasksRepo.stepsOf(task.id);

  for (const step of steps) {
    if (step.status !== 'COMPLETED') continue;

    const outputs = (step.output as { outputs?: OutputReference[] } | null)?.outputs ?? [];

    for (const output of outputs) {
      const summary = summariseOutput(output);
      if (!summary) continue;

      fragments.push(
        fragment({
          id: `output-${output.id}`,
          kind: output.type.startsWith('sources') ? 'research' : 'tool-result',
          /*
           * Retrieved sources are evidence; computed results are tool output;
           * written prose is a draft. The type decides, because the same step
           * can produce all three.
           */
          authority: output.type.startsWith('sources')
            ? 'external-evidence'
            : output.type.startsWith('prose') || output.type.startsWith('literature')
              ? 'model-generated'
              : 'tool-result',
          content: summary,
          provenance: {
            source: output.producedBy.capability,
            id: output.id,
            at: output.createdAt,
          },
          relevance: 0.65,
        }),
      );
    }
  }

  return fragments;
}

/**
 * A short, factual description of a typed output.
 *
 * Summarised rather than included whole: a search result carries twelve
 * references and a review carries two thousand words, and putting either
 * verbatim into every downstream call is what the token budget exists to
 * prevent.
 */
function summariseOutput(output: OutputReference): string | null {
  const data = output.data as Record<string, unknown> | null;
  if (!data) return null;

  if (output.type.startsWith('sources')) {
    const references = (data.references as { title?: string; year?: number; doi?: string }[]) ?? [];
    if (references.length === 0) return null;

    return `Sources found (${references.length}): ${references
      .slice(0, 8)
      .map((reference) => `${reference.title ?? ''} (${reference.year ?? 'n.d.'})`)
      .join('; ')}`;
  }

  if (typeof data.text === 'string') {
    /* The opening, which identifies it; the rest is retrievable by reference. */
    return `${output.type}: ${data.text.slice(0, 400)}${data.text.length > 400 ? '…' : ''}`;
  }

  if (output.type.startsWith('artifact')) {
    return `File produced: ${String(data.filename ?? '')} (${String(data.kind ?? '')})`;
  }

  const compact = JSON.stringify(data).slice(0, 300);
  return compact === '{}' ? null : `${output.type}: ${compact}`;
}

/**
 * What an uploaded dataset contains.
 *
 * The column list and row count, never the rows. A model deciding which test to
 * run needs to know the variables exist; it does not need the data, and sending
 * it would be both expensive and a way for file content to act as instructions.
 *
 * A dataset that has been deleted, or that belongs to someone else, produces
 * nothing at all — describing a file that is not there would have the model
 * reason about imagined columns.
 */
async function fileFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.datasetId) return [];

  const dataset = await datasetsRepo.findOwned(scope.datasetId, scope.userId);

  if (!dataset) {
    logger.info('context.datasetMissing', { datasetId: scope.datasetId });
    return [];
  }

  /*
   * The profile computed at upload, which holds the column names and types.
   * Read rather than recomputed: the work was already done, and re-reading the
   * file to describe it would be slow and would put its contents in memory for
   * no reason.
   */
  const profile = dataset.profile as {
    columns?: { name?: string; type?: string }[];
    /* Extracted passages, for an uploaded document rather than a table. */
    document?: { sections?: number; words?: number; chunks?: { heading: string; text: string }[] };
  } | null;

  const columns = profile?.columns ?? [];

  /*
   * A document rather than a dataset.
   *
   * Uploads were tabular only, because the product grew out of statistics —
   * so "what does the study I uploaded say about sample size" could not be
   * answered at all. The passages that bear on the request are included; the
   * whole paper is not, because forty pages would consume the budget and bury
   * the sentence that answers the question.
   */
  const chunks = profile?.document?.chunks ?? [];

  if (chunks.length > 0) {
    const passages = retrievePassages(
      chunks.map((chunk, index) => ({ id: `c${index}`, ordinal: index, ...chunk })),
      scope.request ?? '',
      3,
    );

    return [
      fragment({
        id: `document-${dataset.id}`,
        kind: 'file',
        /*
         * The researcher's own material, which is neither a tool measurement
         * nor published evidence. Its own level, because writing "studies have
         * shown" from an uploaded draft attributes their words to the
         * literature — a fabricated citation arrived at honestly.
         */
        authority: 'user-document',
        /*
         * Each passage labelled with where it came from.
         *
         * The passages were included as bare text, so the model quoted the
         * researcher's own paper and wrote "studies have shown" — indistinguishable
         * from something it invented. Every other kind of evidence in this system
         * carries provenance; an uploaded document arrived without it, which is
         * the one place where being unable to tell matters most.
         */
        content: [
          `The researcher uploaded "${dataset.originalName ?? dataset.id}". Passages from it follow. Attribute anything you take from them to this file — it is their own material, not published literature, so it is not a citation.`,
          '',
          ...passages.map((passage) =>
            passage.heading
              ? `[${dataset.originalName ?? 'file'} — ${passage.heading}]\n${passage.text}`
              : `[${dataset.originalName ?? 'file'}]\n${passage.text}`,
          ),
        ]
          .filter(Boolean)
          .join('\n\n'),
        provenance: { source: 'document', id: dataset.id },
        relevance: 0.9,
      }),
    ];
  }

  return [
    fragment({
      id: `dataset-${dataset.id}`,
      kind: 'file',
      /* A tool read this file. It is a measurement, not a claim. */
      authority: 'tool-result',
      content: [
        `Dataset: ${dataset.originalName ?? dataset.id}`,
        dataset.rowCount ? `Rows: ${dataset.rowCount}` : '',
        columns.length > 0
          ? `Columns (${columns.length}): ${columns
              .slice(0, 60)
              .map((column) => `${column.name}${column.type ? ` [${column.type}]` : ''}`)
              .join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      provenance: { source: 'dataset', id: dataset.id },
      relevance: 0.85,
    }),
  ];
}

/**
 * Files this task or project has produced.
 *
 * Named and referenced, never embedded. "Give me that as PDF" needs to know a
 * Word file exists and which task made it; the document's contents are already
 * reachable through its outputs.
 */
async function artifactFragments(scope: SourceScope): Promise<ContextFragment[]> {
  if (!scope.projectId && !scope.taskId) return [];

  const artifacts = scope.projectId
    ? await artifactsRepo.listForProject(scope.projectId, scope.userId)
    : await artifactsRepo.listLatest(scope.userId, 10);

  const relevant = scope.taskId
    ? artifacts.filter(
        (artifact) => (artifact.metadata as { taskId?: string } | null)?.taskId === scope.taskId,
      )
    : artifacts;

  return relevant.slice(0, 10).map((artifact) =>
    fragment({
      id: `artifact-${artifact.id}`,
      kind: 'artifact',
      authority: 'tool-result',
      content: `File available: ${artifact.filename} (${artifact.kind}, version ${artifact.version})`,
      provenance: {
        source: 'artifact',
        id: artifact.id,
        at: artifact.createdAt?.toISOString(),
      },
      relevance: 0.5,
    }),
  );
}
