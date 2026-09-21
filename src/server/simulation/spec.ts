/**
 * From what a model read in a paper to a specification the generator can use.
 *
 * The extraction is the one place a model touches this feature, and the one
 * place it can do damage: asked for a paper's sample size and correlations, a
 * model that cannot find a value will often supply a plausible one. Everything
 * here assumes it might have.
 *
 * Two defences. The reply is normalised against a closed shape — unknown
 * fields are dropped, numbers outside what the statistic can be are dropped,
 * names are resolved against the constructs actually listed. And every number
 * that survives is looked for in the paper's own text: one that is not there
 * is kept, because a PDF's tables do not always survive text extraction, but
 * it is marked, and the report tells the reader to check it against the paper.
 *
 * Pure — no model, no database — so it can be tested without either.
 */

import type { ConstructSpec, SimulationSpec } from '@/analysis/simulate';

export type SpecProblem =
  /** No sample size could be read. The generator cannot guess one. */
  | 'n.missing'
  /** No constructs could be read: nothing to simulate. */
  | 'constructs.missing'
  /** No response scale was stated; five points were assumed. */
  | 'scale.assumed'
  /** An item count was not stated for a construct; three were assumed. */
  | 'items.assumed';

export interface NormalisedSpec {
  spec: SimulationSpec;
  title: string;
  /** Construct names mapped to the labels the paper uses. */
  labels: Record<string, string>;
  problems: { code: SpecProblem; subject?: string }[];
  notes: string[];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(toAsciiDigits(value).replace(/^\./, '0.').replace(/^-\./, '-0.'));
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
}

/** Arabic-Indic and Persian digits, and the Arabic decimal mark, as ASCII. */
export function toAsciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

/**
 * A column-safe name.
 *
 * Column names end up in CSV headers, in model syntax, and in formulas a
 * student types. An Arabic label with spaces works in none of those reliably,
 * so the name is Latin and short, and the label is kept beside it.
 */
function columnName(candidate: string, position: number, used: Set<string>): string {
  let name = candidate
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_]/g, '')
    .replace(/^\d+/, '')
    .slice(0, 12);

  if (!name) name = `C${position + 1}`;

  let unique = name;
  for (let suffix = 2; used.has(unique.toUpperCase()); suffix += 1) unique = `${name}_${suffix}`;

  used.add(unique.toUpperCase());
  return unique;
}

/**
 * Normalises a model's reading of a paper.
 *
 * `overrides` are the researcher's own answers — a sample size typed into the
 * chat when the paper's could not be read — and win over anything extracted.
 */
export function normaliseSpec(
  raw: unknown,
  options: { seed: number; n?: number; maxRows: number },
): NormalisedSpec {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const problems: NormalisedSpec['problems'] = [];

  /* ------------------------------- constructs ------------------------------ */
  const used = new Set<string>(['_SIMULATED', 'RESPONDENT_ID']);
  const labels: Record<string, string> = {};
  const lookup = new Map<string, string>();

  const constructs: ConstructSpec[] = [];
  const reverseCoded: string[] = [];

  asList(source.constructs)
    .slice(0, 40)
    .forEach((entry, position) => {
      const given = asText(entry.name);
      const label = asText(entry.label) || given;
      if (!given && !label) return;

      const name = columnName(given || label, position, used);

      const loadings = Array.isArray(entry.loadings)
        ? entry.loadings
            .map((value) => asNumber(value))
            .filter((value): value is number => value !== undefined && Math.abs(value) > 0 && Math.abs(value) < 1)
        : [];

      let items = asNumber(entry.items);

      if (items === undefined || !Number.isInteger(items) || items < 1 || items > 40) {
        if (loadings.length > 0) {
          items = loadings.length;
        } else {
          items = 3;
          problems.push({ code: 'items.assumed', subject: name });
        }
      }

      const alpha = asNumber(entry.alpha);
      const sd = asNumber(entry.sd);

      /*
       * The generator uses the size of a loading and not its sign: papers
       * report items after reverse-scoring, and a negative loading in a table
       * is nearly always an item that was not. Said, rather than done quietly.
       */
      if (loadings.some((value) => value < 0)) {
        reverseCoded.push(name);
      }

      constructs.push({
        name,
        label,
        items,
        ...(asNumber(entry.mean) !== undefined ? { mean: asNumber(entry.mean) as number } : {}),
        ...(sd !== undefined && sd > 0 ? { sd } : {}),
        ...(alpha !== undefined && alpha > 0 && alpha < 1 ? { alpha } : {}),
        ...(loadings.length === items ? { loadings } : {}),
      });

      labels[name] = label;

      for (const key of [given, label, name]) {
        /* First come, first served: a later duplicate must not capture an earlier name. */
        if (key && !lookup.has(key.toLowerCase())) lookup.set(key.toLowerCase(), name);
      }
    });

  if (constructs.length === 0) problems.push({ code: 'constructs.missing' });

  const resolve = (value: unknown): string | undefined => lookup.get(asText(value).toLowerCase());

  /* ------------------------------ relationships ---------------------------- */
  const seenPairs = new Set<string>();

  const correlations = asList(source.correlations).flatMap((entry) => {
    const a = resolve(entry.a);
    const b = resolve(entry.b);
    const r = asNumber(entry.r);

    if (!a || !b || a === b || r === undefined || Math.abs(r) >= 1) return [];

    const key = [a, b].sort().join('|');
    if (seenPairs.has(key)) return [];
    seenPairs.add(key);

    return [{ a, b, r }];
  });

  const seenPaths = new Set<string>();

  const paths = asList(source.paths).flatMap((entry) => {
    const from = resolve(entry.from);
    const to = resolve(entry.to);
    const beta = asNumber(entry.beta);

    if (!from || !to || from === to || beta === undefined || Math.abs(beta) >= 1) return [];

    const key = `${from}>${to}`;
    if (seenPaths.has(key)) return [];
    seenPaths.add(key);

    return [{ from, to, beta }];
  });

  /* ------------------------------- demographics ---------------------------- */
  const demographics = asList(source.demographics)
    .slice(0, 12)
    .flatMap((entry, position) => {
      const categories = asList(entry.categories).flatMap((category) => {
        const label = asText(category.label);
        let share = asNumber(category.share);

        if (!label || share === undefined || share <= 0) return [];

        /* Percentages, where the paper gave them as such. */
        if (share > 1) share /= 100;

        return share <= 1 ? [{ label: label.slice(0, 60), share }] : [];
      });

      if (categories.length < 2) return [];

      return [{ name: columnName(asText(entry.name) || `demo${position + 1}`, position, used), categories }];
    });

  /* ------------------------------ scale and size --------------------------- */
  const scaleSource = (typeof source.scale === 'object' && source.scale !== null ? source.scale : {}) as Record<
    string,
    unknown
  >;

  let min = asNumber(scaleSource.min);
  let max = asNumber(scaleSource.max);

  if (min === undefined || max === undefined || !Number.isInteger(min) || !Number.isInteger(max) || max <= min) {
    min = 1;
    max = 5;
    problems.push({ code: 'scale.assumed' });
  }

  /*
   * A mean outside the scale means the scale was read wrongly — a seven-point
   * instrument described somewhere as "Likert". Widened rather than clipping
   * every mean to five, which would quietly change what the paper reported.
   */
  const highest = Math.max(...constructs.map((construct) => construct.mean ?? Number.NEGATIVE_INFINITY));
  if (Number.isFinite(highest) && highest > max) max = Math.ceil(highest) <= 7 ? 7 : Math.ceil(highest);

  let n = options.n ?? asNumber(source.n);

  if (n === undefined || !Number.isInteger(n) || n < 10) {
    n = 0;
    problems.push({ code: 'n.missing' });
  } else if (n > options.maxRows) {
    n = options.maxRows;
  }

  const notes = Array.isArray(source.notes)
    ? source.notes.map((note) => asText(note)).filter(Boolean).slice(0, 10)
    : [];

  if (reverseCoded.length > 0) {
    notes.push(
      `Negative loadings were published for ${reverseCoded.join(', ')}; the simulated items are all scored in the same direction (as after reverse-scoring).`,
    );
  }

  return {
    spec: {
      n,
      scale: { min, max },
      constructs,
      ...(correlations.length > 0 ? { correlations } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(demographics.length > 0 ? { demographics } : {}),
      seed: options.seed,
    },
    title: asText(source.title).slice(0, 200),
    labels,
    problems,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Checking against the paper                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether a number appears in the text as a number.
 *
 * Papers write .84, 0.84 and 0.840 for the same value, and Arabic papers write
 * it in either digit set. Bounded on both sides so that 0.84 is not "found"
 * inside 10.845.
 */
export function numberAppears(value: number, asciiText: string): boolean {
  if (!Number.isFinite(value)) return false;

  const magnitude = Math.abs(value);

  if (Number.isInteger(magnitude)) {
    return new RegExp(`(?<![\\d.])${magnitude}(?:\\.0+)?(?!\\d|[.,]\\d)`).test(asciiText.replace(/(\d),(\d{3})/g, '$1$2'));
  }

  const [whole = '0', fraction = ''] = String(magnitude).split('.');
  const lead = whole === '0' ? '0?' : whole;

  return new RegExp(`(?<![\\d.])${lead}[.,]${fraction}0*(?!\\d)`).test(asciiText);
}

export interface UnverifiedValue {
  statistic: 'n' | 'mean' | 'sd' | 'alpha' | 'loading' | 'correlation' | 'path';
  subject: string;
  value: number;
}

/** Every extracted number that could not be found in the paper's text. */
export function unverifiedValues(spec: SimulationSpec, text: string): UnverifiedValue[] {
  const ascii = toAsciiDigits(text);
  const missing: UnverifiedValue[] = [];

  const look = (statistic: UnverifiedValue['statistic'], subject: string, value: number | undefined) => {
    if (value === undefined) return;
    if (!numberAppears(value, ascii)) missing.push({ statistic, subject, value });
  };

  look('n', 'N', spec.n);

  for (const construct of spec.constructs) {
    look('mean', construct.name, construct.mean);
    look('sd', construct.name, construct.sd);
    look('alpha', construct.name, construct.alpha);
    (construct.loadings ?? []).forEach((loading, item) => look('loading', `${construct.name}${item + 1}`, loading));
  }

  for (const entry of spec.correlations ?? []) look('correlation', `${entry.a} ~ ${entry.b}`, entry.r);
  for (const path of spec.paths ?? []) look('path', `${path.from} → ${path.to}`, path.beta);

  return missing;
}

/* -------------------------------------------------------------------------- */
/*                         Choosing what the model reads                      */
/* -------------------------------------------------------------------------- */

const STATISTICAL_TERMS =
  /sample|respondent|participant|questionnaire|likert|mean|standard deviation|cronbach|alpha|reliab|loading|correlation|fornell|ave\b|path coefficient|beta|hypothes|table|عينة|العينة|مستجيب|استبان|ليكرت|المتوسط|الانحراف|كرونباخ|ألفا|الثبات|تشبع|ارتباط|معامل|المسار|فرضي|جدول/i;

/**
 * The passages most likely to carry the numbers, in their original order.
 *
 * A paper is mostly literature review, and sending all of it spends the context
 * on prose that contains no statistic. Passages are ranked by how numeric and
 * how methodological they are, the best are kept up to a budget, and they are
 * put back in reading order — a correlation table read before the list of
 * constructs it abbreviates is much harder to interpret.
 */
export function statisticalPassages(
  chunks: { heading?: string; text: string }[],
  budgetCharacters = 48_000,
): string {
  const scored = chunks.map((chunk, position) => {
    const text = `${chunk.heading ?? ''}\n${chunk.text}`;
    const digits = (toAsciiDigits(text).match(/\d/g) ?? []).length;

    return {
      position,
      text,
      score: digits / Math.max(40, text.length) + (STATISTICAL_TERMS.test(text) ? 0.15 : 0),
    };
  });

  const kept: typeof scored = [];
  let spent = 0;

  for (const entry of [...scored].sort((a, b) => b.score - a.score)) {
    if (spent + entry.text.length > budgetCharacters) continue;
    kept.push(entry);
    spent += entry.text.length;
  }

  return kept
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.text)
    .join('\n\n');
}

/** The instruction given to the model that reads the paper. */
export const EXTRACTION_PROMPT = `You read the methods and results of an academic paper and copy out the statistics it PUBLISHES. You are a transcriber. You never estimate, infer, average, or fill a gap.

Return JSON only, in this shape:

{
  "title": "<the paper's title, if visible>",
  "n": <the final analysed sample size as an integer, or null>,
  "scale": {"min": 1, "max": 5} or null,
  "constructs": [
    {
      "name": "<the abbreviation the paper uses, Latin letters, e.g. PU>",
      "label": "<the construct's full name as written>",
      "items": <number of items/indicators, or null>,
      "mean": <published mean of the construct, or null>,
      "sd": <published standard deviation, or null>,
      "alpha": <published Cronbach's alpha, or null>,
      "loadings": [<published standardised loadings, one per item>] or null
    }
  ],
  "correlations": [{"a": "<name>", "b": "<name>", "r": <published correlation>}],
  "paths": [{"from": "<name>", "to": "<name>", "beta": <published standardised path coefficient>}],
  "demographics": [{"name": "<variable>", "categories": [{"label": "<category>", "share": <proportion between 0 and 1>}]}],
  "notes": ["<anything a reader should know: values that were unclear, tables that were unreadable>"]
}

Rules:

1. Copy only numbers that appear in the text given to you. If a value is not there, write null or leave the list empty. A missing value is a correct answer; an invented one is a serious error.
2. In a Fornell–Larcker table the diagonal is the square root of AVE, not a correlation. Copy only the off-diagonal values as correlations. Do not copy HTMT ratios as correlations.
3. Composite reliability is not Cronbach's alpha. Put a value under "alpha" only when the paper calls it Cronbach's alpha.
4. Path coefficients are the standardised betas of the structural model. Do not copy t-values, p-values or f² as betas.
5. If the paper reports several samples or models, copy the main one and say which in "notes".
6. Text extracted from a PDF may have broken tables. If a table cannot be read reliably, leave its values out and say so in "notes".`;
