/**
 * The routing rule, and nothing else.
 *
 * Separated from the router because this is arithmetic on a classification —
 * no model, no network, no database. Importing the router pulls in the intent
 * classifier and through it the AI service and the database, and a test
 * checking that "a request for a file becomes a task" should not need a
 * database to do it.
 *
 * That coupling has now appeared nine times in this codebase. The pattern is
 * always the same: a module needs one small pure function, imports the module
 * that happens to contain it, and drags everything behind it.
 */

import type { IntentResult } from '@/agents/intent';

/**
 * A word boundary that works in every script.
 *
 * `\b` is defined by the ASCII word class and never matches between two Arabic
 * letters, so an Arabic pattern anchored with it matches nothing — silently,
 * in every input. Two patterns elsewhere in this codebase were dead for that
 * reason before anyone noticed.
 *
 * This asserts that what follows is not a letter or digit in any script, which
 * is what a word boundary means when the alphabet is not Latin.
 */
const WORD_END = String.raw`(?![\p{L}\p{N}])`;

/** The same, at the start: not preceded by a letter or digit. */
const WORD_START = String.raw`(?<![\p{L}\p{N}])`;
import type { RouteDecision, RoutePath } from './router';

/*
 * References to earlier work, by the kind of thing they point at.
 *
 * These are demonstratives — "it", "the previous one", "هاي" — and they are
 * genuinely lexical: a pronoun is a pronoun, and no amount of semantic
 * analysis changes which noun phrase it stands for. What the pronoun *resolves
 * to* is context work, done elsewhere; noticing that one is present is this.
 */
const REFERS_BACK = {
  artifact: [
    /\b(?:the\s+)?(?:previous|last|earlier)\s+(?:file|document|report|paper)\b/i,
    /\b(?:convert|turn|export)\s+(?:it|that|this)\b/i,
    new RegExp(
      `(?:الملف|البحث|المستند|التقرير|الورقة|الفصل)\\s*(?:السابق|السابقة|اللي\\s*قبل|الأخير|الأخيرة|الماضي)`,
      'u',
    ),
    new RegExp(`${WORD_START}(?:حوّله|حوله|حوّل|حول|حوليه|خليه|اعمله|سوّيه)`, 'u'),
  ],
  prose: [
    /\b(?:shorten|expand|rewrite|revise|edit)\s+(?:it|that|this|the\s+\w+)\b/i,
    /*
     * The verb is what carries the reference; what follows it varies. "اختصر
     * الفصل الثالث" names a chapter, "اختصره" attaches a pronoun, and
     * "اختصر اللي كتبته" names a clause — requiring a particular noun shape
     * after the verb missed all but the first.
     */
    /*
     * The verb carries the reference; what follows it varies. "اختصر الفصل
     * الثالث" names a chapter, "اختصره" attaches a pronoun, "اختصر اللي كتبته"
     * names a clause — requiring a particular noun shape missed all but one.
     *
     * No `\b` here: a word boundary is defined by the ASCII word character
     * class, so it never matches between two Arabic letters and the anchor
     * silently fails. The alternation is anchored to the start of a word by
     * the optional prefix instead.
     */
    /*
     * Anchored with a Unicode-safe boundary rather than `\b`, and matching the
     * verb rather than what follows it: "اختصر الفصل الثالث" names a chapter,
     * "اختصره" attaches a pronoun, "اختصر اللي كتبته" names a clause, and
     * requiring a particular noun shape after the verb missed all but one.
     */
    new RegExp(
      `${WORD_START}(?:اختصر|اختصري|طوّل|طول|أعد\\s*كتابة|اعد\\s*كتابة|عدّل|عدل|صحّح|صحح|راجع|لخّص|لخص)`,
      'u',
    ),
  ],
  dataset: [
    /\b(?:this|the|my)\s+(?:data|dataset|file|spreadsheet)\b/i,
    new RegExp(
      `${WORD_START}(?:هاي|هذه|هذي|هاد|هذا)\\s*(?:الداتا|البيانات|الملف|الجدول|الإكسل|الاكسل)`,
      'u',
    ),
  ],
  task: [
    /\b(?:continue|carry on|resume|finish)\b/i,
    new RegExp(`${WORD_START}(?:أكمل|اكمل|كمّل|كمل|تابع|واصل|كفي)${WORD_END}`, 'u'),
  ],
} as const;


/**
 * The routing rule itself, separated so it can be tested without a model.
 *
 * Ordered from most certain to least. Each condition is a reason the request
 * cannot be answered conversationally, and the fast path is what remains.
 */
export function decide(input: {
  intent: Pick<IntentResult, 'intent' | 'confidence'>;
  needsTools: boolean;
  wantsFile: boolean;
  referencesPrevious: RouteDecision['referencesPrevious'];
  hasDataset: boolean;
}): { path: RoutePath; reason: string; confidence: number } {
  /*
   * A file was asked for. Producing one is a task with an artifact at the end,
   * and no conversational answer satisfies it — telling someone to copy text
   * into Word is the failure this product was built to remove.
   */
  if (input.wantsFile) {
    return { path: 'agent', reason: 'a file was requested', confidence: 0.9 };
  }

  /* The intent names work that needs a tool: a search, a computation, a file. */
  if (input.needsTools) {
    return { path: 'agent', reason: `intent ${input.intent.intent} needs tools`, confidence: 0.85 };
  }

  /*
   * A reference to earlier work that produced a file or prose. Resolving it
   * means reading artifacts and outputs, which is agent work — and answering
   * "convert it to PDF" conversationally would produce a description of a file
   * rather than a file.
   */
  if (input.referencesPrevious === 'artifact' || input.referencesPrevious === 'prose') {
    return { path: 'agent', reason: 'refers to earlier work', confidence: 0.75 };
  }

  /*
   * A dataset present and an analysis intent. The classifier has seen the
   * columns; if it thinks the message is about them, the numbers must come
   * from the engines and not from the model's imagination.
   */
  if (input.hasDataset && input.intent.intent.startsWith('stats.')) {
    return { path: 'agent', reason: 'analysis of an attached dataset', confidence: 0.9 };
  }

  /*
   * Everything else answers conversationally.
   *
   * Including low-confidence classifications: uncertainty about *which tool*
   * is not evidence that a tool is needed, and sending an ordinary question
   * through a planner costs the researcher a minute to be told what a sentence
   * would have said. The fast path escalates if it turns out to be wrong,
   * which is the safer direction to be wrong in.
   */
  return {
    path: 'fast',
    reason: 'answerable directly',
    confidence: input.intent.confidence,
  };
}

/**
 * Whether the message points at something earlier, and at what kind of thing.
 *
 * Only meaningful when earlier work exists: "convert it" in the first message
 * of a conversation refers to nothing, and treating it as a reference would
 * send the request to an agent that has nothing to convert.
 */
export function detectReference(
  message: string,
  hasPriorWork: boolean,
): RouteDecision['referencesPrevious'] {
  if (!hasPriorWork) return null;

  /*
   * Ordered by specificity. "Convert the previous file to PDF" refers to an
   * artifact and also matches the prose patterns; the artifact reading is the
   * right one, so it is checked first.
   */
  for (const kind of ['artifact', 'prose', 'dataset', 'task'] as const) {
    if (REFERS_BACK[kind].some((pattern) => pattern.test(message))) return kind;
  }

  return null;
}
