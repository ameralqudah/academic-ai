/**
 * Reading a model out of a sentence.
 *
 * "Job satisfaction affects performance, and performance affects loyalty"
 * describes a path model completely. A researcher who can say that should not
 * have to click through six dropdowns to express it.
 *
 * **What this produces is a proposal, never a model that runs.** The extraction
 * fills the same builder the form fills, and the researcher confirms or corrects
 * it before anything is estimated. That is not a courtesy: a model is a
 * statement about what a study claims, and a language model guessing which
 * questionnaire items measure "satisfaction" is guessing at the researcher's
 * construct definitions. It can propose; it cannot decide.
 *
 * **Two things are extracted, and they are not equally reliable.** The
 * structure — which construct affects which — comes almost verbatim from the
 * sentence and is usually right. The measurement — which columns belong to
 * which construct — is a guess from column names, and is often wrong on real
 * data where items are called `Q17_3`. So indicators are matched by name where
 * the match is unambiguous and left empty otherwise, rather than assigned on a
 * weak resemblance that a researcher might not check.
 */

import { modelToDraft, type PlsModelDraft } from './schema';

export interface ExtractedModel {
  draft: PlsModelDraft;
  /**
   * Constructs the sentence named but whose indicators could not be matched.
   *
   * Surfaced so the interface can say "I could not tell which items measure
   * loyalty" rather than presenting an empty construct as though it were
   * complete.
   */
  unmatchedConstructs: string[];
  /** Columns the extraction assigned, so a reviewer can see what it touched. */
  matchedIndicators: Record<string, string[]>;
}

/**
 * The shape a language model is asked to return.
 *
 * Deliberately minimal: construct names and directed pairs, nothing about
 * indicators. Asking a model to also pick columns invites confident nonsense on
 * a file where items are called `V23`, and the matching is better done here
 * against the actual column list.
 */
export interface ProposedStructure {
  constructs: string[];
  paths: { from: string; to: string }[];
}

/**
 * The instruction given to the model.
 *
 * Kept here rather than in the prompt directory because it is part of this
 * feature's contract: the parsing below assumes exactly this output shape, and
 * separating the two would let one change without the other.
 */
export const STRUCTURE_EXTRACTION_PROMPT = `You extract structural equation models from a researcher's description.

Return ONLY valid JSON, with no explanation and no markdown fence:
{"constructs":["Name One","Name Two"],"paths":[{"from":"Name One","to":"Name Two"}]}

Rules:
- Every name in "paths" must appear in "constructs".
- Use the researcher's own wording for names, cleaned of filler.
- "A affects B", "A influences B", "A leads to B", "A predicts B" all mean {"from":"A","to":"B"}.
- "B depends on A", "B is affected by A" mean {"from":"A","to":"B"} — the direction reverses.
- A mediator sits in two paths: "A affects B which affects C" gives A→B and B→C, not A→C.
- Only add A→C if the researcher says A also affects C directly.
- If the description names no relationship, return empty arrays.
- Never invent a construct the researcher did not mention.`;

/**
 * Turns a proposed structure into a draft, matching indicators where it can.
 *
 * The matching is deliberately conservative. A column matches a construct when
 * its name contains the construct's name or an unambiguous abbreviation of it —
 * `satisfaction_1` for "Satisfaction", `SAT3` for "Satisfaction". Anything less
 * certain is left unmatched, because an indicator quietly assigned to the wrong
 * construct produces a model that estimates, reports, and measures something
 * nobody intended.
 */
export function buildDraftFromStructure(
  structure: ProposedStructure,
  columns: string[],
): ExtractedModel {
  const matched: Record<string, string[]> = {};
  const unmatched: string[] = [];
  const claimed = new Set<string>();

  for (const name of structure.constructs) {
    const indicators = matchIndicators(name, columns, claimed);

    if (indicators.length === 0) {
      unmatched.push(name);
    } else {
      matched[name] = indicators;
      for (const indicator of indicators) claimed.add(indicator);
    }
  }

  const draft = modelToDraft({
    constructs: structure.constructs.map((name) => ({
      name,
      /*
       * An unmatched construct still appears, with no indicators. The builder
       * shows it as incomplete and the researcher fills it in — which is more
       * useful than dropping it and leaving them to work out what went missing.
       */
      indicators: matched[name] ?? [],
      mode: 'reflective' as const,
    })),
    paths: structure.paths,
  });

  return { draft, unmatchedConstructs: unmatched, matchedIndicators: matched };
}

/**
 * Columns that plausibly measure a construct.
 *
 * Three passes, from most to least certain, stopping at the first that finds
 * anything. Mixing them would let a weak match compete with a strong one.
 */
function matchIndicators(
  constructName: string,
  columns: string[],
  claimed: Set<string>,
): string[] {
  const available = columns.filter((column) => !claimed.has(column));
  const normalised = normalise(constructName);

  if (normalised.length < 3) return [];

  /* 1. The construct's name appears in the column name. */
  const byName = available.filter((column) => normalise(column).includes(normalised));
  if (byName.length > 0) return byName;

  /*
   * 2. A prefix abbreviation — `SAT1`, `SAT2` for "Satisfaction".
   *
   * The comparison runs from the column, not from the construct. An earlier
   * version took the construct's first four characters — `sati` — and looked
   * for columns starting with them, which misses `SAT1` entirely: the
   * abbreviation researchers use is shorter than four letters more often than
   * not. The right question is whether the column's letter part is a prefix
   * *of* the construct name.
   *
   * The trailing digits are what distinguish an item series from a coincidence.
   * Without them `SATURATION_LEVEL` would match, and it measures something
   * else.
   */
  const byPrefix = available.filter((column) => {
    const clean = normalise(column);
    const match = clean.match(/^([a-z\u0600-\u06ff]+)(\d+)$/);
    if (!match) return false;

    const letters = match[1] as string;
    return letters.length >= 3 && normalised.startsWith(letters);
  });

  if (byPrefix.length > 0) return byPrefix;

  /*
   * 3. The first significant word — "satisfaction" from "job satisfaction".
   *
   * Last because it is the weakest: two constructs sharing a word would both
   * match the same columns, and the `claimed` set means whichever is processed
   * first takes them. That is why anything matched this way should be reviewed,
   * and why the result is presented for confirmation rather than run.
   */
  const words = constructName
    .split(/\s+/)
    .map(normalise)
    .filter((word) => word.length >= 4);

  for (const word of words) {
    const byWord = available.filter((column) => normalise(column).includes(word));
    if (byWord.length > 0) return byWord;
  }

  return [];
}

/** Lowercased, with separators and Arabic diacritics removed. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064b-\u0652]/g, '')
    .replace(/[\s_\-.]/g, '');
}

/**
 * Parses the model's reply into a structure.
 *
 * Tolerant of a markdown fence and of surrounding prose, because a model told
 * to return only JSON will occasionally return JSON with an explanation. What
 * it will not do is accept a shape that is nearly right: a path naming a
 * construct that was not listed produces a model the engine would refuse, and
 * catching it here means the researcher sees "I could not read that" rather
 * than a validation error about their own sentence.
 */
export function parseProposedStructure(reply: string): ProposedStructure | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? reply).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const raw = parsed as { constructs?: unknown; paths?: unknown };

  if (!Array.isArray(raw.constructs) || !Array.isArray(raw.paths)) return null;

  const constructs = raw.constructs
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 80);

  if (constructs.length < 2) return null;

  const names = new Set(constructs);

  const paths = raw.paths
    .filter((path): path is { from: string; to: string } => {
      if (!path || typeof path !== 'object') return false;
      const entry = path as { from?: unknown; to?: unknown };
      return typeof entry.from === 'string' && typeof entry.to === 'string';
    })
    .map((path) => ({ from: path.from.trim(), to: path.to.trim() }))
    /*
     * Paths naming an unlisted construct are dropped rather than added to the
     * construct list. A model that invents an endpoint has misread the
     * sentence, and silently adding it would put a construct in the
     * researcher's model that they never mentioned.
     */
    .filter((path) => names.has(path.from) && names.has(path.to) && path.from !== path.to);

  if (paths.length === 0) return null;

  return { constructs, paths };
}
