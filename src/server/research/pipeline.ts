/**
 * Deep research as a workflow, not a prompt.
 *
 * The tempting implementation is one large instruction — "research this
 * thoroughly and write a report with citations" — and it produces something
 * that reads like research and is not. The model has no sources, so it writes
 * from memory; the citations are plausible and unverifiable; and a student
 * submits a literature review of papers that may not exist.
 *
 * What follows is the actual shape of the work:
 *
 *   plan → search each sub-question → collect → deduplicate → read →
 *   extract evidence → find what is missing → search again for it → synthesise
 *
 * Each step's output is data the next step consumes, and every claim in the
 * final report traces to a source that was retrieved. The model is used four
 * times — to plan, to extract, to judge gaps, and to write — and never to
 * supply a fact.
 *
 * **Both kinds of source, deliberately.** Academic search finds peer-reviewed
 * work; web search finds current practice, statistics and reports that never
 * enter a journal. A review of either alone is a partial answer, and which one
 * a claim came from is carried through to the report because a thesis committee
 * treats them differently.
 *
 * **Long-running by nature.** Fifteen searches, eight page fetches and four
 * model calls do not fit in an HTTP request, so this reports progress and is
 * driven by the job runner that already exists for bootstrapping.
 */

import { logger } from '@/lib/logger';
import { fetchSources } from '@/server/knowledge/fetch-content';
import { SerperProvider } from '@/server/knowledge/providers/serper';
import { search as searchAcademic } from '@/server/knowledge';
import type { Source } from '@/server/knowledge/types';
import { deduplicate, sameSource } from './dedupe';
import {
  extractEvidence,
  identifyGaps,
  planResearch,
  synthesiseReport,
} from '@/server/services/ai.service';

/** Sub-questions. More than this and the searches outlast anyone's patience. */
const MAX_SUB_QUESTIONS = 5;
/** Sources kept per sub-question after ranking. */
const PER_QUESTION = 6;
/** Pages read in full. The rest are kept as snippets and remain citable. */
const PAGES_TO_READ = 8;
/** One extra round of searching for gaps. Two would rarely converge. */
const GAP_ROUNDS = 1;

export type ResearchStage =
  | 'planning'
  | 'searching'
  | 'collecting'
  | 'reading'
  | 'extracting'
  | 'checking-gaps'
  | 'searching-gaps'
  | 'synthesising'
  | 'done';

export interface ResearchProgress {
  stage: ResearchStage;
  percent: number;
  /** Human-facing detail — which sub-question, how many sources so far. */
  detail?: Record<string, string | number>;
}

export interface ResearchSource extends Source {
  index: number;
  /** Which sub-question surfaced it; a source can answer more than one. */
  answering: string[];
  wasRead: boolean;
}

export interface DeepResearchReport {
  question: string;
  subQuestions: string[];
  /** What each sub-question turned out to support, in the model's words. */
  evidence: { subQuestion: string; findings: string; sourceIndices: number[] }[];
  /** Questions the sources did not answer, stated rather than papered over. */
  remainingGaps: string[];
  report: string;
  sources: ResearchSource[];
  stats: {
    searchesRun: number;
    sourcesFound: number;
    duplicatesRemoved: number;
    pagesRead: number;
    unreachable: number;
    academicSources: number;
    webSources: number;
  };
  tookMs: number;
}

export interface PipelineOptions {
  userId: string;
  question: string;
  locale: 'ar' | 'en';
  onProgress?: (progress: ResearchProgress) => void;
  shouldStop?: () => boolean;
}

const web = new SerperProvider();

/**
 * Runs the full workflow.
 *
 * Cancellation is checked between stages rather than inside them: a stage is
 * seconds, and interrupting mid-search would leave sources half-collected for
 * no gain.
 */
export async function runDeepResearch(options: PipelineOptions): Promise<DeepResearchReport> {
  const startedAt = Date.now();
  const report = (stage: ResearchStage, percent: number, detail?: Record<string, string | number>) =>
    options.onProgress?.({ stage, percent, detail });

  /* ------------------------------- 1. plan ------------------------------- */

  report('planning', 5);

  const plan = await planResearch({
    userId: options.userId,
    question: options.question,
    locale: options.locale,
    maxQuestions: MAX_SUB_QUESTIONS,
  });

  /*
   * A plan that comes back empty falls through to the original question rather
   * than failing. A question the planner could not decompose is usually already
   * specific enough to search directly.
   */
  const subQuestions = plan.length > 0 ? plan.slice(0, MAX_SUB_QUESTIONS) : [options.question];

  logger.info('deepResearch.planned', {
    question: options.question.slice(0, 100),
    subQuestions: subQuestions.length,
  });

  if (options.shouldStop?.()) throw new ResearchCancelled();

  /* ------------------------------ 2. search ------------------------------ */

  const collected: Source[] = [];
  const answeredBy = new Map<string, Set<string>>();
  let searchesRun = 0;

  for (const [position, subQuestion] of subQuestions.entries()) {
    report('searching', 10 + Math.round((position / subQuestions.length) * 30), {
      current: subQuestion,
      done: position,
      total: subQuestions.length,
    });

    /*
     * Academic and web searched together per sub-question. Sequential across
     * sub-questions and parallel within one: the two providers are independent,
     * and running fifteen searches at once would hit both rate limits.
     */
    const [academic, webResults] = await Promise.all([
      searchAcademic({
        queries: [{ text: subQuestion, language: options.locale }],
        kind: 'academic',
        preferredLanguage: options.locale,
        limit: PER_QUESTION,
      }).catch(() => null),
      web.isConfigured()
        ? web.search({ text: subQuestion, language: options.locale, kind: 'web', limit: PER_QUESTION })
        : Promise.resolve(null),
    ]);

    searchesRun += 2;

    for (const source of academic?.sources ?? []) {
      collected.push(source);
      track(answeredBy, source.url, subQuestion);
    }

    for (const source of webResults?.sources ?? []) {
      collected.push(source);
      track(answeredBy, source.url, subQuestion);
    }

    if (options.shouldStop?.()) throw new ResearchCancelled();
  }

  /* --------------------------- 3. deduplicate ---------------------------- */

  report('collecting', 42, { found: collected.length });

  const { unique, removed } = deduplicate(collected);

  /* ------------------------------- 4. read ------------------------------- */

  report('reading', 48, { sources: unique.length });

  /*
   * Web pages are read; academic sources are not. A journal article's URL is
   * usually a paywall or a landing page, and fetching it returns a cookie
   * notice — the abstract from the provider is better than the page.
   */
  const readable = unique
    .filter((source) => source.kind === 'web')
    .slice(0, PAGES_TO_READ)
    .map((source) => source.url);

  const { fetched, failed } = readable.length > 0
    ? await fetchSources(readable)
    : { fetched: [], failed: [] };

  const contentByUrl = new Map(fetched.map((page) => [page.url, page.text]));

  if (options.shouldStop?.()) throw new ResearchCancelled();

  const numbered: ResearchSource[] = unique.map((source, index) => ({
    ...source,
    index: index + 1,
    answering: [...(answeredBy.get(source.url) ?? [])],
    wasRead: contentByUrl.has(source.url),
  }));

  /* ----------------------------- 5. extract ------------------------------ */

  report('extracting', 60, { sources: numbered.length });

  const evidence: DeepResearchReport['evidence'] = [];

  for (const [position, subQuestion] of subQuestions.entries()) {
    const relevant = numbered.filter((source) => source.answering.includes(subQuestion));
    if (relevant.length === 0) continue;

    const extracted = await extractEvidence({
      userId: options.userId,
      subQuestion,
      locale: options.locale,
      sources: relevant.map((source) => ({
        index: source.index,
        title: source.title,
        content: contentByUrl.get(source.url) ?? source.snippet ?? '',
        kind: source.kind,
      })),
    });

    evidence.push({
      subQuestion,
      findings: extracted,
      sourceIndices: relevant.map((source) => source.index),
    });

    report('extracting', 60 + Math.round((position / subQuestions.length) * 15));

    if (options.shouldStop?.()) throw new ResearchCancelled();
  }

  /* ------------------------------ 6. gaps -------------------------------- */

  report('checking-gaps', 78);

  let gaps = await identifyGaps({
    userId: options.userId,
    question: options.question,
    locale: options.locale,
    evidence: evidence.map((entry) => ({ subQuestion: entry.subQuestion, findings: entry.findings })),
  });

  /*
   * One extra round of searching, for the gaps the evidence did not close.
   *
   * Bounded at one because a second round rarely converges: the questions a
   * first pass could not answer are usually questions the sources do not
   * contain, and searching again finds the same sources. What remains unanswered
   * is reported as a gap, which is more useful to a researcher than a report
   * that pretends completeness.
   */
  if (gaps.length > 0 && GAP_ROUNDS > 0 && !options.shouldStop?.()) {
    report('searching-gaps', 82, { gaps: gaps.length });

    for (const gap of gaps.slice(0, 3)) {
      const [academic, webResults] = await Promise.all([
        searchAcademic({
          queries: [{ text: gap, language: options.locale }],
          kind: 'academic',
          preferredLanguage: options.locale,
          limit: 3,
        }).catch(() => null),
        web.isConfigured()
          ? web.search({ text: gap, language: options.locale, kind: 'web', limit: 3 })
          : Promise.resolve(null),
      ]);

      searchesRun += 2;

      const extra = [...(academic?.sources ?? []), ...(webResults?.sources ?? [])];

      for (const source of extra) {
        if (numbered.some((existing) => sameSource(existing, source))) continue;

        numbered.push({
          ...source,
          index: numbered.length + 1,
          answering: [gap],
          wasRead: false,
        });
        track(answeredBy, source.url, gap);
      }
    }

    /* Re-checked against the enlarged set: some gaps will now be closed. */
    gaps = await identifyGaps({
      userId: options.userId,
      question: options.question,
      locale: options.locale,
      evidence: [
        ...evidence.map((entry) => ({ subQuestion: entry.subQuestion, findings: entry.findings })),
        {
          subQuestion: 'Additional sources found for open questions',
          findings: numbered
            .filter((source) => !source.wasRead && source.snippet)
            .slice(-9)
            .map((source) => `[${source.index}] ${source.title}: ${source.snippet}`)
            .join('\n'),
        },
      ],
    });
  }

  if (options.shouldStop?.()) throw new ResearchCancelled();

  /* --------------------------- 7. synthesise ----------------------------- */

  report('synthesising', 90, { sources: numbered.length });

  const written = await synthesiseReport({
    userId: options.userId,
    question: options.question,
    locale: options.locale,
    evidence,
    gaps,
    sources: numbered.map((source) => ({
      index: source.index,
      title: source.title,
      url: source.url,
      kind: source.kind,
      year: source.year,
      container: source.container,
    })),
  });

  report('done', 100);

  const academicCount = numbered.filter((source) => source.kind === 'academic').length;

  logger.info('deepResearch.completed', {
    question: options.question.slice(0, 100),
    subQuestions: subQuestions.length,
    sources: numbered.length,
    searches: searchesRun,
    gaps: gaps.length,
    ms: Date.now() - startedAt,
  });

  return {
    question: options.question,
    subQuestions,
    evidence,
    remainingGaps: gaps,
    report: written,
    sources: numbered,
    stats: {
      searchesRun,
      sourcesFound: collected.length,
      duplicatesRemoved: removed,
      pagesRead: fetched.length,
      unreachable: failed.length,
      academicSources: academicCount,
      webSources: numbered.length - academicCount,
    },
    tookMs: Date.now() - startedAt,
  };
}

export class ResearchCancelled extends Error {
  constructor() {
    super('research.cancelled');
    this.name = 'ResearchCancelled';
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Support                                   */
/* -------------------------------------------------------------------------- */

function track(map: Map<string, Set<string>>, url: string, question: string): void {
  const set = map.get(url);
  if (set) set.add(question);
  else map.set(url, new Set([question]));
}

export { MAX_SUB_QUESTIONS, PAGES_TO_READ };
