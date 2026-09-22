/**
 * A measurement model read from the file, and a structural one from words.
 *
 * AMOS and SmartPLS both start with the same drawing: each construct and the
 * questionnaire items that measure it. A survey file already says this in its
 * column names — SQ1, SQ2, SQ3 are the items of SQ — so the constructs are
 * read from there rather than asked for. Which construct affects which is the
 * researcher's theory, and is never inferred: it is read from what they wrote,
 * or asked.
 */

import type { LatentConstruct, StructuralPath } from './inference/pls/schema';
import { itemGroups } from './infer-roles';
import type { DatasetProfile } from './types';

/** The constructs a file's item names imply, each with at least two items. */
export function constructsFromItems(profile: DatasetProfile): LatentConstruct[] {
  const used = new Set<string>();

  return itemGroups(profile).map((group, index) => {
    const first = group[0]?.name.trim() ?? '';
    const stem = /^(.*?)[\s_.-]?\d{1,3}$/u.exec(first)?.[1]?.replace(/[\s_.-]+$/u, '') ?? '';
    let name = stem || `F${index + 1}`;
    while (used.has(name.toLowerCase())) name = `${name}_${index + 1}`;
    used.add(name.toLowerCase());

    return { name, indicators: group.map((column) => column.name), mode: 'reflective' as const };
  });
}

/* Words that put a cause before its effect, in the languages researchers write. */
const LEADS_TO = new RegExp(
  [
    String.raw`->|→|=>|⟶`,
    String.raw`\b(?:to|on|predicts?|affects?|influences?|impacts?|leads?\s+to|causes?)\b`,
    String.raw`(?<![\p{L}])(?:على|في|الى|إلى|يؤثر|تؤثر|يتنبأ|تتنبأ|ب)(?![\p{L}])`,
  ].join('|'),
  'iu',
);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Paths the researcher wrote, between constructs that exist.
 *
 * "SQ -> SAT, SAT -> LOY", or "SQ يؤثر على SAT": each clause naming two
 * constructs with a word of direction between them is one path, from the
 * first named to the second. A clause that names one, or three, is not read —
 * guessing which pair was meant is guessing the theory.
 */
export function pathsFromText(text: string, constructs: string[]): StructuralPath[] {
  const paths: StructuralPath[] = [];
  const seen = new Set<string>();

  for (const clause of text.split(/[\n,،;؛]|\s+(?:and|و)\s+/iu)) {
    const found = constructs
      .flatMap((name) => {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'giu');
        return [...clause.matchAll(pattern)].map((match) => ({ name, at: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
      })
      .sort((a, b) => a.at - b.at);

    if (found.length !== 2 || !found[0] || !found[1] || found[0].name === found[1].name) continue;
    const between = clause.slice(found[0].end, found[1].at);
    if (!LEADS_TO.test(between)) continue;

    const key = `${found[0].name}→${found[1].name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push({ from: found[0].name, to: found[1].name });
  }

  return paths;
}
