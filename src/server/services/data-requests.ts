/**
 * Which requests are about the data, and which columns they name.
 *
 * Pure, so the router, the planner and the tests can use them without the
 * database that the analysis itself needs.
 */

import { asksForCharts } from '@/server/charts/requests';

import type { DatasetProfile } from '@/analysis/types';

const DATA_INTENTS = new Set([
  'data.inspect',
  'data.describe',
  'data.clean',
  'stats.recommend',
  'stats.reliability',
  'stats.compare',
  'stats.relate',
  'stats.predict',
  'stats.categorical',
  'stats.nonparametric',
  'stats.logistic',
  'stats.plsSem',
  'stats.cbSem',
]);

/** Whether a request of this kind is one this path answers. */
export function isDataIntent(intent: string): boolean {
  return DATA_INTENTS.has(intent);
}

/**
 * Columns a message names, found by the names themselves.
 *
 * The classifier's list is used first. This covers what it cannot see: the
 * researcher's reply to a question, which never passes through it.
 */
export function columnsNamedIn(text: string, profile: DatasetProfile): string[] {
  const lower = text.toLowerCase();
  return profile.columns
    .filter((column) => column.name.trim().length > 1 && lower.includes(column.name.toLowerCase()))
    .map((column) => column.name);
}

/* The start of a word, in any script: \b does not see Arabic letters. */
const START = String.raw`(?<![\p{L}\p{N}])`;

/*
 * Programs and methods named in a request. Each is a name, not a sentence, so
 * matching the word is the right tool: "AMOS" means AMOS in every dialect.
 */
const COVARIANCE_SEM = new RegExp(
  [
    `${START}(?:amos|lisrel|mplus|lavaan|cb[-\\s]?sem|cfa|التحليل\\s+العاملي\\s+التوكيدي|تحليل\\s+عاملي\\s+توكيدي)`,
    /*
     * The measurement model — the outer model — is the factor model and
     * nothing else: which items load on which construct, and how well. It
     * needs no paths, and asking for them stopped a researcher who had asked
     * for exactly the analysis this runs.
     */
    String.raw`\b(?:measure?ment|measurment|outer)\s+model\b`,
    `${START}(?:نموذج|النموذج)\\s*(?:ال)?قياس`,
  ].join('|'),
  'iu',
);
const VARIANCE_SEM = new RegExp(`${START}(?:smart\\s?-?pls|pls(?:[-\\s]?sem)?|warp\\s?pls|adanco)(?![\\p{L}])`, 'iu');
const STATISTICS_PACKAGE = new RegExp(
  `${START}(?:spss|jamovi|jasp|stata|minitab|eviews|r\\s+studio|rstudio)(?![\\p{L}])`,
  'iu',
);
const ANALYSIS_WORDS = new RegExp(
  [
    String.raw`\b(?:analy[sz]e|analysis|statistics|descriptive|frequencies|frequency\s+table|tables?)\b`,
    `${START}(?:و?حلل|حلّل|و?تحليل|احصاء|إحصاء|احصائي|إحصائي|جداول|جدول|تكرارات|التكرارات|وصفي|اوصف|أوصف|وصّف|وصف)`,
  ].join('|'),
  'iu',
);
const WHOLE = new RegExp(`${START}(?:كامل|كاملة|شامل|شاملة|كل\\s+شي|كل\\s+شيء|full|complete|everything|whole)`, 'iu');

/**
 * The analysis a request names by its program or method, if it names one.
 *
 * "حلل AMOS" asks for a covariance-based factor model, "SmartPLS" for a
 * variance-based one, and "SPSS" for the tables a statistics package prints.
 * The classifier knows the words; it did not know that they are instructions.
 */
export function softwareIntentOf(message: string): 'stats.cbSem' | 'stats.plsSem' | 'data.describe' | null {
  if (COVARIANCE_SEM.test(message)) return 'stats.cbSem';
  if (VARIANCE_SEM.test(message)) return 'stats.plsSem';
  if (STATISTICS_PACKAGE.test(message)) return 'data.describe';
  return null;
}

/** Whether a message asks for its data to be analysed, in any words. */
export function asksForAnalysis(message: string): boolean {
  return ANALYSIS_WORDS.test(message) || asksForCharts(message) || softwareIntentOf(message) !== null;
}

/** "Analyse everything": the full set of tables rather than one of them. */
export function asksForEverything(message: string): boolean {
  return WHOLE.test(message) || STATISTICS_PACKAGE.test(message);
}

export { asksForCharts } from '@/server/charts/requests';

