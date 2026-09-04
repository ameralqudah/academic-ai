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
import * as tasksRepo from '@/server/repositories/tasks.repository';
import type { OutputReference } from '@/server/tasks/contracts';

import { fragment, type ContextFragment } from './envelope';

export interface SourceScope {
  userId: string;
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
  const [conversation, project, task, file, artifacts] = await Promise.all([
    conversationFragments(scope).catch(recover('conversation')),
    projectFragments(scope).catch(recover('project')),
    taskFragments(scope).catch(recover('task')),
    fileFragments(scope).catch(recover('file')),
    artifactFragments(scope).catch(recover('artifact')),
  ]);

  return [
    ...instructionFragments(scope),
    ...conversation,
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
  const messages = await conversationsRepo.listMessages(scope.conversationId, 20);

  return messages
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
  const profile = dataset.profile as { columns?: { name?: string; type?: string }[] } | null;
  const columns = profile?.columns ?? [];

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
