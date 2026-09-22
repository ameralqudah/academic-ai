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
  asksAboutEarlierWork?: boolean;
  wantsDiagram?: boolean;
}): { path: RoutePath; reason: string; confidence: number } {
  /*
   * A drawing of the research model. First, because the direct answer cannot
   * draw — it produced boxes of dashes in a code block — and because the short
   * "بدي رسمة" otherwise reads as a question about earlier work.
   */
  if (input.wantsDiagram) {
    return { path: 'agent', reason: 'a diagram was requested', confidence: 0.9 };
  }

  /*
   * A file was asked for. Producing one is a task with an artifact at the end,
   * and no conversational answer satisfies it — telling someone to copy text
   * into Word is the failure this product was built to remove.
   */
  if (input.wantsFile) {
    return { path: 'agent', reason: 'a file was requested', confidence: 0.9 };
  }

  /*
   * A short question about what is already here. Before the tool rule, because
   * the classifier reads "the dimensions of each variable" as research and the
   * research is on screen; a task would start without it.
   */
  if (input.asksAboutEarlierWork && ABOUT_THE_WRITING.has(input.intent.intent)) {
    return { path: 'fast', reason: 'a question about earlier work', confidence: 0.8 };
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

/*
 * A file format, named. Kept here as well as in the continuity module because
 * this file is pure and that one reaches the database; the list is short and
 * a format's name does not change.
 */
const NAMES_FORMAT = new RegExp(
  String.raw`\b(?:word|docx|pdf|powerpoint|pptx|excel|xlsx)\b|وورد|ورد|بي\s*دي\s*اف|بوربوينت|إكسل|اكسل`,
  'iu',
);

/* Asking to be handed something: a verb of giving, or a pronoun standing for the thing. */
const ASKS_TO_BE_HANDED = new RegExp(
  [
    String.raw`\b(?:give|send|export|download|save|get|want|need|make)\b`,
    String.raw`\b(?:it|this|that)\b`,
    `${WORD_START}(?:[أا]عط(?:ي)?ني|عطيني|هات|بدي|[أا]ريد|ابعت|ابعث|[أا]رسل|نز[ّ]?ل|صد[ّ]?ر|حم[ّ]?ل|طل[ّ]?ع|احفظ|جهز|جهّز)`,
    `${WORD_START}(?:[إا]ياه|[إا]ياها|ياه|ياها)${WORD_END}`,
  ].join('|'),
  'iu',
);

/* Words that bring a subject of their own, which makes the request a new piece of work. */
const BRINGS_A_SUBJECT = new RegExp(
  String.raw`\b(?:write|draft|compose|about|regarding|chapter|section|on the topic)\b|${WORD_START}(?:[أا]كتب|اكتبي|عن|حول|بخصوص|فصل|الفصل|قسم)${WORD_END}`,
  'iu',
);

/**
 * Whether a message asks only for a file of what already exists.
 *
 * "اعطيني اياه ملف وورد", sent straight after a finished paper, reached the
 * planner as a request with no subject. The planner could make nothing of it,
 * the fallback answered conversationally, and the answer was that the product
 * cannot export Word files — which it can, and had the paper to export.
 *
 * Three things together, because each alone is too loose: a format is named,
 * something is asked to be handed over, and the message brings no subject of
 * its own. "Write chapter one as a Word file" names a format and is new work.
 * Short, because a pronoun carries a request only when little else does.
 */
export function asksForAFileOfIt(message: string): boolean {
  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 10) return false;

  return (
    NAMES_FORMAT.test(message) && ASKS_TO_BE_HANDED.test(message) && !BRINGS_A_SUBJECT.test(message)
  );
}

/* Verbs that ask for something to be made, which is a task whatever else the message says. */
const ASKS_TO_MAKE = new RegExp(
  [
    String.raw`\b(?:write|draft|compose|search|find|look\s*up|analy[sz]e|run|compute|calculate|generate|create|build|design|make|produce|prepare|review|summari[sz]e)\b`,
    `${WORD_START}(?:[أا]كتب|اكتبي|[أا]نشئ|[أا]عد|[أا]عدّ|جهز|جهّز|صمم|صمّم|[أا]نتج|[أا]عمل|اعمللي|سو[يّ]|سوّي|ابحث|دو[ّ]?ر|حلل|حلّل|احسب|شغل|شغّل|ول[ّ]?د|راجع|لخ[ّ]?ص|اختصر|طو[ّ]?ل|عد[ّ]?ل|صح[ّ]?ح)`,
  ].join('|'),
  'iu',
);

/*
 * Intents a short question can turn out to be about the writing on screen.
 * A literature or web search is asked for its sources and is never satisfied
 * from the conversation; a statistic needs the engines. Only the intents that
 * concern the document itself can be answered by reading it.
 */
const ABOUT_THE_WRITING = new Set(['research.section', 'research.plan', 'research.results']);

/**
 * Whether a message is a question about work already in the conversation.
 *
 * "اعطيني الابعاد لكل متغير", asked under a finished paper, was classified as
 * a research section — reasonably, it is about a paper — and became a task.
 * A task starts from nothing; the model in it had never seen the paper and
 * asked which variables were meant. A direct answer sees the conversation and
 * would have listed them.
 *
 * Short, brings no verb of making, names no file, and there is earlier work
 * for it to be about. "Write the methodology" is not this — it asks for a
 * chapter, which is a task, and the task is now told what it continues.
 */
export function asksAboutEarlierWork(message: string, hasPriorWork: boolean): boolean {
  if (!hasPriorWork) return false;

  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 14) return false;

  return !ASKS_TO_MAKE.test(message) && !NAMES_FORMAT.test(message);
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

  /*
   * After the demonstratives, so "convert the previous file" keeps its own
   * reading. An artifact, because a file is what is asked for; resolving it
   * falls back to what was written when no file exists yet.
   */
  if (asksForAFileOfIt(message)) return 'artifact';

  return null;
}
