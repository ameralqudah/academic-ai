/**
 * Which variable plays which part, read from how the researcher asked.
 *
 * The analysis agent asked for roles through a picker: the researcher had to
 * say, in a form, which column was the outcome — after already saying it in
 * words. "Compare satisfaction between men and women" names a numeric outcome
 * and a two-level grouping variable; the profile says which is which. This
 * reads both and assigns the roles a person would.
 *
 * Deterministic, and it refuses rather than guesses. When the words and the
 * columns do not settle a role — two numeric columns and "compare", or no
 * column named at all — it says what is missing and lists what it found, and
 * the researcher decides. A wrong role produces a test that runs and a result
 * that means nothing, which is worse than a question.
 */

import type { RoleAssignment } from './inference/recommend';
import type { ColumnProfile, DatasetProfile } from './types';

export type AnalysisIntent =
  | 'stats.compare'
  | 'stats.relate'
  | 'stats.predict'
  | 'stats.categorical'
  | 'stats.reliability'
  | 'stats.recommend'
  | 'stats.nonparametric'
  | 'stats.logistic';

export type RoleInference =
  | { roles: RoleAssignment[]; note?: string }
  | {
      missing: 'variables' | 'outcome' | 'grouping' | 'items';
      /** The columns that could fill the gap, for the question. */
      candidates: ColumnProfile[];
    };

const MAX_GROUPS = 12;

export function isQuantitative(column: ColumnProfile): boolean {
  if (column.constant) return false;
  return (
    column.type === 'numeric' ||
    column.type === 'integer' ||
    column.type === 'likert' ||
    column.scale === 'interval' ||
    column.scale === 'ratio'
  );
}

export function isGrouping(column: ColumnProfile): boolean {
  if (column.constant) return false;
  return (
    (column.type === 'categorical' || column.type === 'binary' || column.scale === 'nominal') &&
    column.distinct >= 2 &&
    column.distinct <= MAX_GROUPS
  );
}

/**
 * The columns a message names, in the order it names them.
 *
 * The classifier returns the names it recognised; their order in the sentence
 * is what separates "the effect of X on Y" from "predict Y from X".
 */
export function namedColumns(message: string, mentioned: string[], profile: DatasetProfile): ColumnProfile[] {
  const lower = message.toLowerCase();
  return mentioned
    .map((name) => profile.columns.find((column) => column.name === name))
    .filter((column): column is ColumnProfile => Boolean(column))
    .filter((column, index, all) => all.findIndex((other) => other.name === column.name) === index)
    .map((column) => ({ column, at: lower.indexOf(column.name.toLowerCase()) }))
    .sort((a, b) => (a.at < 0 ? 1e9 : a.at) - (b.at < 0 ? 1e9 : b.at))
    .map((entry) => entry.column);
}

/* "Predict Y from X" names the outcome first; "the effect of X on Y", last. */
const OUTCOME_FIRST = /\b(?:predict|predicting|explain(?:ing)?\s+variance\s+in|determinants\s+of|factors\s+(?:affecting|influencing))\b|تنبؤ|التنبؤ\s*ب|يتنبأ|العوامل\s*المؤثرة\s*في|محددات/iu;

/**
 * Scale items that belong together: q1, q2, q3 or SAT1…SAT4 — the same letters
 * followed by a number. Alpha across two scales mixed together means nothing,
 * so items are only taken as a set when exactly one such set exists.
 */
export function itemGroups(profile: DatasetProfile): ColumnProfile[][] {
  const groups = new Map<string, ColumnProfile[]>();
  for (const column of profile.columns) {
    if (!isQuantitative(column)) continue;
    const match = /^(.*?)[\s_.-]?(\d{1,3})$/u.exec(column.name.trim());
    if (!match || !match[1]) continue;
    const stem = match[1].toLowerCase();
    groups.set(stem, [...(groups.get(stem) ?? []), column]);
  }
  return [...groups.values()].filter((group) => group.length >= 2);
}

export function inferRoles(input: {
  intent: AnalysisIntent | string;
  message: string;
  mentioned: string[];
  profile: DatasetProfile;
}): RoleInference {
  const named = namedColumns(input.message, input.mentioned, input.profile);
  const quantitative = named.filter(isQuantitative);
  const grouping = named.filter(isGrouping);
  const everyQuantitative = input.profile.columns.filter(isQuantitative);
  const everyGrouping = input.profile.columns.filter(isGrouping);

  /* ------------------------------ reliability ----------------------------- */

  if (input.intent === 'stats.reliability') {
    if (quantitative.length >= 2) return { roles: quantitative.map((column) => ({ column: column.name, role: 'dependent' })) };

    const groups = itemGroups(input.profile);
    if (groups.length === 1) {
      return {
        roles: (groups[0] as ColumnProfile[]).map((column) => ({ column: column.name, role: 'dependent' })),
        note: 'items-by-name',
      };
    }
    return { missing: 'items', candidates: groups.flat().length ? groups.flat() : everyQuantitative };
  }

  if (named.length === 0) return { missing: 'variables', candidates: input.profile.columns.filter((c) => !c.constant) };

  /* ------------------------------ comparison ------------------------------ */

  const compare = (): RoleInference => {
    const group = grouping[0];
    const outcome = quantitative.find((column) => column.name !== group?.name);
    if (!outcome) return { missing: 'outcome', candidates: everyQuantitative };
    if (!group) return { missing: 'grouping', candidates: everyGrouping };
    return {
      roles: [
        { column: outcome.name, role: 'dependent' },
        { column: group.name, role: 'grouping' },
      ],
    };
  };

  switch (input.intent) {
    case 'stats.compare':
    case 'stats.nonparametric':
      return compare();

    case 'stats.categorical': {
      if (grouping.length < 2) return { missing: 'variables', candidates: everyGrouping };
      return {
        roles: [
          { column: (grouping[0] as ColumnProfile).name, role: 'dependent' },
          { column: (grouping[1] as ColumnProfile).name, role: 'independent' },
        ],
      };
    }

    case 'stats.relate': {
      /* A category and a number is a comparison, whatever it was called. */
      if (grouping.length >= 1 && quantitative.length >= 1 && named.length === 2) return compare();
      if (grouping.length >= 2 && quantitative.length === 0) {
        return {
          roles: [
            { column: (grouping[0] as ColumnProfile).name, role: 'dependent' },
            { column: (grouping[1] as ColumnProfile).name, role: 'independent' },
          ],
        };
      }
      if (quantitative.length < 2) return { missing: 'variables', candidates: everyQuantitative };
      /* No outcome: a correlation between the variables named. */
      return { roles: quantitative.map((column) => ({ column: column.name, role: 'independent' })) };
    }

    case 'stats.predict':
    case 'stats.logistic': {
      if (named.length < 2) return { missing: 'variables', candidates: input.profile.columns.filter((c) => !c.constant) };
      const outcome = OUTCOME_FIRST.test(input.message) ? named[0] : named[named.length - 1];
      return {
        roles: [
          { column: (outcome as ColumnProfile).name, role: 'dependent' },
          ...named
            .filter((column) => column.name !== outcome?.name)
            .map((column) => ({ column: column.name, role: 'independent' as const })),
        ],
      };
    }

    case 'stats.recommend':
    default: {
      if (grouping.length >= 1 && quantitative.length >= 1) return compare();
      if (quantitative.length >= 2) return { roles: quantitative.map((column) => ({ column: column.name, role: 'independent' })) };
      if (grouping.length >= 2) {
        return {
          roles: [
            { column: (grouping[0] as ColumnProfile).name, role: 'dependent' },
            { column: (grouping[1] as ColumnProfile).name, role: 'independent' },
          ],
        };
      }
      return { missing: 'variables', candidates: input.profile.columns.filter((c) => !c.constant) };
    }
  }
}
