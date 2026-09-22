/**
 * Which requests are about the data, and which columns they name.
 *
 * Pure, so the router, the planner and the tests can use them without the
 * database that the analysis itself needs.
 */

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
