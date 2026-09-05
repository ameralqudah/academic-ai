/**
 * Deciding what a message needs, so the user does not have to.
 *
 * Every message went to one of four places depending on a dropdown: chat, web
 * search, deep research, or workspace. That works and it makes the researcher
 * the router — they must know that "analyse my data" belongs in one mode and
 * "explain Cronbach's alpha" in another, before they know what the product
 * does. A researcher who picks wrong gets a conversational answer to a request
 * that needed a file, which reads as the product being incapable.
 *
 * So the decision is made here, once, from the message and its context.
 *
 * **This is a routing decision, not a plan.** It says whether tools are needed
 * and hints at which; the planner decides what actually runs. Keeping that line
 * matters: a router that also planned would be a second planner, and the two
 * would disagree.
 *
 * **Ambiguity goes to the fast path.** A slow answer to a simple question costs
 * seconds; a conversational answer to a request that needed a dataset wastes
 * the researcher's time and their trust. The fast path can escalate when it
 * discovers it needs a tool — the reverse is not possible.
 */

import { logger } from '@/lib/logger';
import { classifyIntent, type IntentResult } from '@/agents/intent';
import { decide, detectReference } from './routing-rules';
import type { DatasetProfile } from '@/analysis/types';

export type RoutePath = 'fast' | 'agent';

export interface RouteDecision {
  path: RoutePath;
  /**
   * Why, in a phrase. Logged rather than shown: a wrong decision needs to be
   * traceable, and explaining routing to the user is the mode dropdown by
   * another name.
   */
  reason: string;
  confidence: number;
  /**
   * Capabilities the request appears to need.
   *
   * A hint for the planner, never an instruction. The planner reads the whole
   * request and the available context; this reads one message. Where they
   * disagree, the planner is right.
   */
  suggestedCapabilities: string[];
  /**
   * What the message refers to without naming: "the previous file", "it".
   *
   * Resolved later against the context. Recorded here because the router is
   * where the reference is noticed.
   */
  referencesPrevious: 'artifact' | 'prose' | 'dataset' | 'task' | null;
  /** Carried through so the caller need not classify twice. */
  intent: IntentResult;
}

/*
 * Intents that cannot be answered from the model's own knowledge.
 *
 * Derived from what each capability does rather than from phrasing: a request
 * for current information needs a search whatever words carry it, and a
 * reliability coefficient needs a dataset and arithmetic. Listing intents
 * rather than keywords is what makes this work across dialects and typos —
 * the classifier already handled the language, and this reads its answer.
 */
const NEEDS_TOOLS = new Set([
  /* Anything needing sources the model does not hold. */
  'research.web',
  'research.deep',
  'research.literature',
  'research.plan',
  'research.section',
  'research.results',
  'research.survey',

  /*
   * Anything needing arithmetic over a dataset. The engines are authoritative
   * here — a model that computes a correlation from imagination produces a
   * number that looks like a finding.
   */
  'stats.reliability',
  'stats.compare',
  'stats.relate',
  'stats.predict',
  'stats.categorical',
  'stats.nonparametric',
  'stats.logistic',
  'stats.plsSem',
  'stats.cbSem',
  'stats.recommend',
  'data.clean',
  'data.describe',
  'data.inspect',
]);

/** Which capability each tool-needing intent points at. */
const CAPABILITY_FOR: Record<string, string[]> = {
  'research.web': ['web.search'],
  'research.deep': ['deep.research'],
  'research.literature': ['academic.search', 'literature.review'],
  'research.plan': ['academic.search', 'document.write'],
  'research.section': ['document.write'],
  'research.results': ['document.write'],
  'research.survey': ['survey.generate'],

  'stats.reliability': ['statistics.run'],
  'stats.compare': ['statistics.run'],
  'stats.relate': ['statistics.run'],
  'stats.predict': ['statistics.run'],
  'stats.categorical': ['statistics.run'],
  'stats.nonparametric': ['statistics.run'],
  'stats.logistic': ['statistics.run'],
  'stats.recommend': ['file.analyse'],
  'stats.plsSem': ['statistics.pls'],
  'stats.cbSem': ['statistics.cbsem'],

  'data.clean': ['file.analyse'],
  'data.describe': ['statistics.run'],
  'data.inspect': ['file.analyse'],
};

/*
 * Formats a request may name, and the fact that naming one implies a file.
 *
 * Matched as words rather than parsed, because this is the one place where a
 * literal is genuinely what is meant: "PDF" names PDF in every language and
 * dialect, and a classifier call to establish that would be a call spent on
 * nothing. The semantic work is the classifier's; this is a lookup.
 */
const FORMAT_WORDS = [
  /\b(?:word|docx)\b/i,
  /\bpdf\b/i,
  /\b(?:powerpoint|pptx|presentation)\b/i,
  /\b(?:excel|xlsx|spreadsheet)\b/i,
  /\bcsv\b/i,
  /\b(?:bibtex|\.bib)\b/i,
  /\bris\b/i,
  /وورد|بي\s*دي\s*اف|بوربوينت|إكسل|اكسل|عرض\s*تقديمي|ملف\s*نصي/,
];


export interface RouteInput {
  message: string;
  locale: 'ar' | 'en';
  /** Whether a file is attached or already in the conversation. */
  hasDataset?: boolean;
  profile?: DatasetProfile | null;
  /** Whether earlier work exists that a reference could point at. */
  hasPriorWork?: boolean;
  history?: { role: 'user' | 'assistant'; content: string }[];
  userId: string;
}

/**
 * Routes one message.
 *
 * The classifier does the semantic work — it already handles dialects, typos
 * and mixed script, and rebuilding that here would be a second, worse copy.
 * This reads its answer and decides what kind of execution the request needs.
 */
export async function routeRequest(input: RouteInput): Promise<RouteDecision> {
  const intent = await classifyIntent({
    message: input.message,
    locale: input.locale,
    profile: input.profile ?? null,
    history: input.history,
  });

  const referencesPrevious = detectReference(input.message, input.hasPriorWork ?? false);

  const wantsFile = FORMAT_WORDS.some((pattern) => pattern.test(input.message));
  const needsTools = NEEDS_TOOLS.has(intent.intent);

  const suggested = new Set(CAPABILITY_FOR[intent.intent] ?? []);
  if (wantsFile) suggested.add('document.generate');

  /*
   * A dataset in the conversation and a request that mentions it. The intent
   * classifier sees the column names, so it has already decided whether the
   * message is about them — this only adds the capability.
   */
  if (input.hasDataset && intent.mentionedColumns.length > 0) {
    suggested.add('file.analyse');
  }

  const decision = decide({
    intent,
    needsTools,
    wantsFile,
    referencesPrevious,
    hasDataset: input.hasDataset ?? false,
  });

  logger.info('route.decided', {
    path: decision.path,
    intent: intent.intent,
    reason: decision.reason,
    confidence: decision.confidence,
    suggested: [...suggested],
    referencesPrevious,
  });

  return {
    ...decision,
    suggestedCapabilities: [...suggested],
    referencesPrevious,
    intent,
  };
}

export { decide, detectReference } from './routing-rules';

