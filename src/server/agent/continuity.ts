/**
 * Working out what "it" is.
 *
 * A researcher writes "حوّله PDF" and means the paper the assistant produced
 * two minutes ago. Nothing in that sentence names it. The router already
 * notices that a reference is present; this decides what it points at.
 *
 * **The decision is made on type, recency and provenance — not on words.**
 * "Convert it to PDF" and "اعمللي PowerPoint منه" refer to the same artifact
 * through entirely different phrasings, and a rule built on phrasings would
 * need a new entry for every way a person can say "that one". What they have
 * in common is structural: a document was produced, and the request wants
 * another form of it.
 *
 * **Ambiguity is never resolved by guessing.** Two candidate files an hour
 * apart is a question, not a coin toss — regenerating the wrong chapter costs
 * the researcher work they had already approved, and asking costs one turn.
 */

import { logger } from '@/lib/logger';
import type { Artifact } from '@/server/db/schema';
import * as artifactsRepo from '@/server/repositories/artifacts.repository';
import * as datasetsRepo from '@/server/repositories/datasets.repository';
import * as tasksRepo from '@/server/repositories/tasks.repository';
import type { OutputReference } from '@/server/tasks/contracts';

/** What kind of earlier thing a message points at. */
export type ReferenceKind = 'artifact' | 'prose' | 'dataset' | 'task';

export interface Candidate {
  kind: ReferenceKind;
  id: string;
  /** Shown to the researcher when they have to choose. */
  label: string;
  /** When it was made. Recency breaks ties; it does not decide alone. */
  at: Date;
  /**
   * Why this is a candidate, for the log.
   *
   * A wrong resolution is the most damaging failure this module can produce —
   * regenerating the wrong chapter destroys approved work — so the reasoning
   * has to be reconstructible after the fact.
   */
  reason: string;
  /** For an artifact: what it is, so a format request can be satisfied. */
  artifact?: Artifact;
  /** For prose: the typed output, so a rewrite has the text. */
  output?: OutputReference;
  /** For a dataset: its id, which the analysis capabilities take. */
  datasetId?: string;
  taskId?: string;
}

export type Resolution =
  /** One clear candidate. The agent proceeds. */
  | { status: 'resolved'; candidate: Candidate }
  /**
   * Several plausible candidates.
   *
   * The researcher chooses. Picking the most recent would be right often
   * enough to be dangerous: it would work until the day it silently rewrote
   * the wrong chapter, and by then nobody would be checking.
   */
  | { status: 'ambiguous'; candidates: Candidate[]; question: string }
  /** Nothing to refer to. The agent asks, or offers to start fresh. */
  | { status: 'none'; question: string };

export interface ResolveInput {
  userId: string;
  kind: ReferenceKind;
  /** The message, used only to narrow by format or ordinal — never to match. */
  message: string;
  locale: 'ar' | 'en';
  conversationId?: string | null;
  projectId?: string | null;
  /**
   * How far back to look.
   *
   * Six hours by default. A reference to "the previous file" means something
   * within the current working session; a document from last week is not what
   * "it" points at, and offering it would be worse than admitting confusion.
   */
  withinHours?: number;
}

/**
 * Finds what a reference points at.
 *
 * Gathers candidates of the right kind, then decides: one is used, several are
 * offered, none produces a question.
 */
export async function resolveReference(input: ResolveInput): Promise<Resolution> {
  const since = new Date(Date.now() - (input.withinHours ?? 6) * 3_600_000);

  const candidates = await gather(input, since);

  if (candidates.length === 0) {
    logger.info('continuity.noCandidates', { kind: input.kind, userId: input.userId });
    return { status: 'none', question: nothingFound(input.kind, input.locale) };
  }

  if (candidates.length === 1) {
    logger.info('continuity.resolved', {
      kind: input.kind,
      id: candidates[0]?.id,
      reason: candidates[0]?.reason,
    });

    return { status: 'resolved', candidate: candidates[0] as Candidate };
  }

  /*
   * Several candidates, and one of them is clearly the subject.
   *
   * "Clearly" is a gap in time, not a rank: a file made two minutes ago and
   * another made an hour ago are not close, and treating them as a choice
   * would ask the researcher a question whose answer is obvious. Two files
   * made within minutes of each other are a genuine question.
   */
  const [first, second] = candidates as [Candidate, Candidate];
  const gapMinutes = (first.at.getTime() - second.at.getTime()) / 60_000;

  if (gapMinutes >= 10) {
    logger.info('continuity.resolvedByRecency', {
      kind: input.kind,
      id: first.id,
      gapMinutes: Math.round(gapMinutes),
    });

    return { status: 'resolved', candidate: first };
  }

  logger.info('continuity.ambiguous', {
    kind: input.kind,
    count: candidates.length,
    gapMinutes: Math.round(gapMinutes),
  });

  return {
    status: 'ambiguous',
    candidates: candidates.slice(0, 5),
    question: chooseOne(candidates.slice(0, 5), input.locale),
  };
}

/**
 * Candidates of the requested kind, newest first.
 *
 * Scoped to the conversation or project where one is given: a reference in one
 * conversation should not reach into another, because two threads about
 * different papers would otherwise contaminate each other.
 */
async function gather(input: ResolveInput, since: Date): Promise<Candidate[]> {
  if (input.kind === 'artifact') return artifactCandidates(input, since);
  if (input.kind === 'dataset') return datasetCandidates(input, since);
  if (input.kind === 'prose') return proseCandidates(input, since);

  return taskCandidates(input, since);
}

/**
 * Files the researcher has produced.
 *
 * Narrowed by format when the message names one — "اعمللي PowerPoint منه" is
 * not asking for the existing presentation, it is asking for a presentation of
 * the existing work, so a named format excludes files that already have it.
 */
async function artifactCandidates(input: ResolveInput, since: Date): Promise<Candidate[]> {
  const artifacts = input.projectId
    ? await artifactsRepo.listForProject(input.projectId, input.userId)
    : await artifactsRepo.listLatest(input.userId, 20);

  const recent = artifacts.filter((artifact) => artifact.createdAt >= since);

  /*
   * A format named in the message is the *target*, not a filter on the source.
   * Someone asking for PDF wants the PDF made from something that is not one.
   */
  const wantedFormat = namedFormat(input.message);

  const usable = wantedFormat
    ? recent.filter((artifact) => artifact.kind !== wantedFormat)
    : recent;

  return usable
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((artifact) => ({
      kind: 'artifact' as const,
      id: artifact.id,
      label: `${artifact.filename} (${artifact.kind}, v${artifact.version})`,
      at: artifact.createdAt,
      reason: wantedFormat ? `source for a ${wantedFormat} conversion` : 'recent file',
      artifact,
      taskId: (artifact.metadata as { taskId?: string } | null)?.taskId,
    }));
}

/**
 * Written text a task produced.
 *
 * Read from typed outputs rather than from a capability name: prose written by
 * `document.write` and by `literature.review` are equally rewritable, and
 * asking for one by producer would miss the other.
 */
async function proseCandidates(input: ResolveInput, since: Date): Promise<Candidate[]> {
  const tasks = await tasksRepo.listForUser(input.userId, 10);

  const scoped = tasks.filter(
    (task) =>
      task.createdAt >= since &&
      (!input.conversationId || task.conversationId === input.conversationId),
  );

  const candidates: Candidate[] = [];

  for (const task of scoped) {
    const steps = await tasksRepo.stepsOf(task.id);

    for (const step of steps) {
      if (step.status !== 'COMPLETED') continue;

      const outputs = (step.output as { outputs?: OutputReference[] } | null)?.outputs ?? [];

      for (const output of outputs) {
        /* Any output carrying text can be shortened or rewritten. */
        if (!output.type.startsWith('prose') && !output.type.startsWith('literature')) continue;

        const data = output.data as { text?: string; heading?: string } | null;
        if (!data?.text) continue;

        candidates.push({
          kind: 'prose',
          id: output.id,
          label: data.heading ?? `${output.type} — ${data.text.slice(0, 60)}…`,
          at: step.finishedAt ?? step.createdAt,
          reason: `written by ${output.producedBy.capability}`,
          output,
          taskId: task.id,
        });
      }
    }
  }

  return candidates.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Files the researcher uploaded. */
async function datasetCandidates(input: ResolveInput, since: Date): Promise<Candidate[]> {
  const datasets = await datasetsRepo.listByUser(input.userId, 20);

  return datasets
    .filter((dataset) => dataset.createdAt >= since && !dataset.deletedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((dataset) => ({
      kind: 'dataset' as const,
      id: dataset.id,
      label: `${dataset.originalName ?? dataset.id}${dataset.rowCount ? ` (${dataset.rowCount} rows)` : ''}`,
      at: dataset.createdAt,
      reason: 'uploaded file',
      datasetId: dataset.id,
    }));
}

/**
 * Work that stopped before finishing.
 *
 * "كمّل من وين وقفنا" points at something incomplete, so a finished task is not
 * a candidate — offering one would mean continuing work that is already done.
 */
async function taskCandidates(input: ResolveInput, since: Date): Promise<Candidate[]> {
  const tasks = await tasksRepo.listForUser(input.userId, 10);

  return tasks
    .filter(
      (task) =>
        task.createdAt >= since &&
        ['PAUSED', 'WAITING_FOR_INPUT', 'FAILED'].includes(task.status) &&
        (!input.conversationId || task.conversationId === input.conversationId),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((task) => ({
      kind: 'task' as const,
      id: task.id,
      label: `${task.request.slice(0, 70)} (${task.status})`,
      at: task.createdAt,
      reason: `unfinished: ${task.status}`,
      taskId: task.id,
    }));
}

/**
 * A file format named in the message.
 *
 * The one place a literal match is right: "PDF" names PDF in every language,
 * and asking a model to establish that would be a call spent on nothing. The
 * semantic work — what the researcher wants done — happened upstream.
 */
export function namedFormat(message: string): string | null {
  const formats: [RegExp, string][] = [
    [/\b(?:word|docx)\b|وورد/i, 'docx'],
    [/\bpdf\b|بي\s*دي\s*اف/i, 'pdf'],
    [/\b(?:powerpoint|pptx|presentation)\b|بوربوينت|عرض\s*تقديمي/i, 'pptx'],
    [/\b(?:excel|xlsx|spreadsheet)\b|إكسل|اكسل/i, 'xlsx'],
    [/\bcsv\b/i, 'csv'],
    [/\bbibtex\b/i, 'bib'],
    [/\bris\b/i, 'ris'],
  ];

  for (const [pattern, format] of formats) {
    if (pattern.test(message)) return format;
  }

  return null;
}

function nothingFound(kind: ReferenceKind, locale: 'ar' | 'en'): string {
  if (locale === 'ar') {
    return kind === 'dataset'
      ? 'لم أجد ملفًا مرفوعًا حديثًا. هل ترفعه؟'
      : kind === 'artifact'
        ? 'لم أجد ملفًا سابقًا لأحوّله. ما الذي تريد تحويله؟'
        : kind === 'prose'
          ? 'لم أجد نصًّا سابقًا لأعدّله. أي جزء تقصد؟'
          : 'لم أجد عملًا متوقّفًا لأكمله.';
  }

  return kind === 'dataset'
    ? 'I could not find a recently uploaded file. Would you like to upload one?'
    : kind === 'artifact'
      ? 'I could not find an earlier file to convert. Which one do you mean?'
      : kind === 'prose'
        ? 'I could not find earlier text to revise. Which part do you mean?'
        : 'I could not find unfinished work to continue.';
}

/**
 * The question asked when several things could be meant.
 *
 * Lists them rather than describing the ambiguity: a researcher who sees two
 * filenames answers in a word, where "which document did you mean?" makes them
 * reconstruct what exists.
 */
function chooseOne(candidates: Candidate[], locale: 'ar' | 'en'): string {
  const list = candidates.map((candidate, index) => `${index + 1}. ${candidate.label}`).join('\n');

  return locale === 'ar'
    ? `أيّها تقصد؟\n${list}`
    : `Which one do you mean?\n${list}`;
}

