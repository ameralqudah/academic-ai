/**
 * The numeric-integrity guard (WS2): one policy for every number in text.
 *
 * The contract
 * ------------
 * - A **research number** reports a result of analysing data, or a
 *   quantitative finding: a statistic assignment ("t(98) = 2.31", "β = .31",
 *   "N = 250", "χ²(3) = 45"), a decimal, or a percentage. Detection is the
 *   P1-C detector (`@/lib/statistics-text`): Arabic-Indic and Persian digits,
 *   comma and Arabic decimal marks, statistic symbols in any script.
 * - An **ordinary number** is not a finding: years in citations, dates,
 *   counts in prose ("240 students", "a 5-point scale"), and labels such as
 *   "H1", "Table 2", "Chapter 3", "pp. 12–15", "Section 2.3", a numbered
 *   heading ("1.2 Background") or a software version ("version 26.0",
 *   "4.3.1"), and a stated criterion rather than a result: a conventional
 *   significance level ("set at α = .05") or a threshold ("above .70 is
 *   acceptable") — see `isStatedCriterion`, which reads only the words next to
 *   the number. Numbers the user supplied themselves (their instruction, the
 *   project's metadata) are allowed as `context`.
 * - **Context-dependent** numbers stay findings unless the user supplied them:
 *   an amount of money ("$3.50" may be an incentive or a measured cost) and a
 *   range ("GPA 2.5 to 4.0" may be an inclusion rule or an observed range). No
 *   value is ever allowed just because it is a common one.
 * - Only a succeeded, pinned P1-C statistics run produces a **verified**
 *   number. This module never labels anything verified: it reports a number as
 *   `traced` when it matches the allowed set a caller built from stored
 *   results, and as a finding otherwise.
 *
 * Modes
 * -----
 * - `strict` — model text on the P1-C chain: every digit outside a
 *   `{{value:key}}` token is a finding; nothing is allowed by value.
 * - `model` — model text on a legacy path: research numbers must be in the
 *   allowed set (or the user's context); the rest are findings, and
 *   `quarantine` replaces them with a visible marker.
 * - `person` — a person's own text: the same detection, reported as manual
 *   numbers; never altered.
 *
 * Everything here is pure and deterministic: the same text and options give
 * the same findings, in text order, and the same quarantined text.
 */

import { ASSIGNMENT, DECIMAL, normaliseDigits, VALUE_TOKEN } from '@/lib/statistics-text';

/** Bumped when detection changes, so a stored check says which rules it used. */
export const NUMERIC_GUARD_VERSION = 'ws2-1';

export type IntegrityMode = 'strict' | 'model' | 'person';

export interface NumberSpan {
  /** The span as written in the original text. */
  text: string;
  /** UTF-16 offset in the original text. */
  index: number;
  length: number;
  /** The number the span carries, normalised ("0.31", "-2.4", "45"). */
  value: string;
  kind: 'statistic' | 'decimal' | 'percent' | 'digit';
}

export interface NumberCheck {
  mode: IntegrityMode;
  guardVersion: string;
  /** Research numbers not traced to an allowed value, in text order. */
  findings: NumberSpan[];
  /** Research numbers matching the allowed set or the user's context. */
  traced: NumberSpan[];
  clean: boolean;
}

export interface CheckOptions {
  mode: IntegrityMode;
  /** Spellings of stored values the text may repeat (see `allowedSpellings`). Ignored in `strict`. */
  allowed?: ReadonlySet<string>;
  /** Text the user supplied (their instruction, project metadata): numbers in it are theirs. Ignored in `strict`. */
  context?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*                                  Spellings                                 */
/* -------------------------------------------------------------------------- */

/** Numeric spellings a stored value may appear as: 0.4567 → "0.457", ".457", "0.46", ".46", "45.67"… */
export function allowedSpellings(values: Iterable<number>): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    for (const digits of [0, 1, 2, 3, 4]) {
      for (const candidate of [value, Math.abs(value)]) {
        const text = candidate.toFixed(digits);
        out.add(text);
        out.add(text.replace(/^(-?)0\./, '$1.'));
      }
    }
    if (Math.abs(value) <= 1) for (const digits of [0, 1, 2]) out.add((Math.abs(value) * 100).toFixed(digits));
  }
  return out;
}

/** "−0,31" → "-0.31"; "+.5" → "0.5". */
function normaliseValue(raw: string): string {
  return raw.replace(/[−–]/g, '-').replace(/^\+/, '').replace(',', '.').trim().replace(/^(-?)\./, '$10.');
}

function isAllowed(value: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(value) || allowed.has(value.replace(/^-/, ''));
}

/** Every number in the user's own text, as the allowed set spells it. */
function contextNumbers(context: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of context) {
    for (const match of normaliseDigits(text).matchAll(/[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)/g)) {
      const value = normaliseValue(match[0]);
      out.add(value);
      out.add(value.replace(/^(-?)0\./, '$1.'));
      out.add(value.replace(/^(-?)\./, '$10.'));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                  Detection                                 */
/* -------------------------------------------------------------------------- */

/**
 * The text the detector reads: tokens blanked to the same length (so offsets
 * stay those of the original) and digits normalised (length-preserving: each
 * replaced character is one UTF-16 unit, as is its replacement).
 *
 * Two Arabic marks the P1-C detector does not read, normalised here only:
 * the Arabic percent sign (٪ → %), and the Arabic comma when it separates
 * (followed by a space, as between degrees of freedom: "F(٢، ٩٧)"). An Arabic
 * comma between two digits is left alone — it is a list mark, not a decimal
 * one (that is ٫, which the P1-C normalisation already reads).
 */
function readable(text: string): string {
  return normaliseDigits(text.replace(VALUE_TOKEN, (token) => ' '.repeat(token.length)))
    .replace(/٪/g, '%')
    .replace(/،(?=\s)/g, ',');
}

/** Arabic words may carry an attached proclitic (و ف ب ل ك): "بالجدول", "وفي الملحق" → "والملحق". */
const AR = (words: string) => String.raw`[وفبلك]?(?:${words})`;
const LABEL_WORDS = String.raw`(?:Table|Tables|Figure|Figures|Fig\.|Section|Sections|Chapter|Chapters|Appendix|Equation|Eq\.|Hypothesis|Hypotheses|Step|Phase|Stage|Model|Study|Experiment|Item|Question|Part|Article|Clause|§|${AR('الجدول|جدول|الشكل|شكل|الفصل|فصل|القسم|قسم|المبحث|الفرضية|فرضية|الملحق|ملحق|المعادلة|معادلة|البند|المادة|الخطوة|المرحلة|النموذج|الدراسة|السؤال')})`;
/** "Table 2.1", "Section 3.4.1", "الجدول 4.2", "Equation (3.2)": a label followed by a dotted number. A bare "(3.2)" is not a label. */
const LABELLED = new RegExp(String.raw`(?<![\p{L}\p{N}])${LABEL_WORDS}\s*\(?\d+(?:\.\d+)+\)?`, 'gu');
/** A numbered heading or list item at the start of a line: "1.2 Background", "## 3.1. Aims". */
const HEADING_NUMBER = /^[ \t]*(?:#{1,6}[ \t]+)?\d+(?:\.\d+)+\.?(?=[ \t])/gmu;
/** Software versions: "version 26.0", "v2.1", "الإصدار 4.2"; and any number with two or more dots ("4.3.1"), which no statistic has. */
const VERSION = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:version|ver\.|v|${AR('الإصدار|إصدار|النسخة')})\s*\d+(?:\.\d+)+|(?<![\p{N}.])\d+(?:\.\d+){2,}(?![\p{N}])`, 'giu');

function ordinaryRanges(normalised: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const pattern of [LABELLED, HEADING_NUMBER, VERSION]) {
    for (const match of normalised.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/*
 * Stated criteria, not findings. Both rules read only the words right next to
 * the number, so a result elsewhere in the same sentence is never excused:
 *
 * - A significance level: a conventional value (.10, .05, .01, .001) right
 *   after a criterion phrase ("set at α = .05", "a significance level of .05",
 *   "عند مستوى الدلالة α = 0.05"), right before "level" ("at the .05 level"),
 *   or as "p < .05 was considered significant". Only α and p, and only these
 *   values: "α = .85" (a reliability) and "p = .03" stay findings.
 * - A threshold: a decimal (never an assignment) right after a comparator
 *   ("above .70", "at least .50", "لا يقل عن ٠٫٧٠") in a sentence that names a
 *   criterion ("acceptable", "recommended", "مقبول"). "Reliability was .70"
 *   stays a finding.
 */
const CONVENTIONAL_LEVELS = new Set(['0.1', '0.10', '0.05', '0.01', '0.001']);
const LEVEL_BEFORE = new RegExp(String.raw`(?:set at|significance level|level of significance|alpha level|α level|significance criterion|nominal level|${AR('مستوى الدلالة|مستوى دلالة|مستوى المعنوية|مستوى معنوية')})(?:\s+(?:of|was|is|at|=))?[\s(:]*$`, 'iu');
const LEVEL_AFTER = /^\s*\)?\s*(?:significance\s+)?level\b/iu;
const CONSIDERED_AFTER = /^\s*(?:was|were|is|are)\s+(?:considered|deemed|regarded as|taken as)\s+(?:statistically\s+)?significant/iu;
const COMPARATOR_BEFORE = new RegExp(
  String.raw`(?:above|below|over|under|exceed(?:s|ed|ing)?|greater than|less than|higher than|lower than|at least|at most|(?:a\s+)?minimum of|(?:a\s+)?maximum of|(?:a\s+)?cut-?off(?:\s+value)? of|(?:a\s+)?threshold(?:\s+value)? of|≥|≤|>|<|أعلى من|أقل من|أكبر من|أصغر من|يزيد على|يزيد عن|زاد على|زاد عن|تزيد على|يتجاوز|تتجاوز|لا يقل عن|لا تقل عن|فوق|دون)\s*(?:the\s+)?(?:recommended\s+|conventional\s+|suggested\s+|accepted\s+|minimum\s+)?\(?$`,
  'iu',
);
const THRESHOLD_WORDS = /acceptable|adequate|recommended|conventional|threshold|cut-?off|criterion|benchmark|rule of thumb|suggested|guideline|مقبول|الحد الأدنى|حد أدنى|المعيار|معيار|يوصى|الموصى|المقترح|عتبة|الحد الفاصل/iu;

/** The sentence around a span: bounded by ; ! ? ؛ a line break, or a full stop followed by a space (not a decimal point). */
function sentenceAround(normalised: string, start: number, end: number): string {
  let from = 0;
  let to = normalised.length;
  for (const match of normalised.matchAll(/[;!?؛\n]|\.(?=\s|$)/g)) {
    if (match.index < start) from = match.index + 1;
    else if (match.index >= end) {
      to = match.index;
      break;
    }
  }
  return normalised.slice(from, to);
}

function isStatedCriterion(normalised: string, found: NumberSpan): boolean {
  const start = found.index;
  const end = found.index + found.length;
  const before = normalised.slice(Math.max(0, start - 60), start);
  const after = normalised.slice(end, end + 60);
  if (CONVENTIONAL_LEVELS.has(found.value)) {
    const symbol = found.kind === 'statistic' ? /^(α|p)\s*([=<>≤≥])/u.exec(normalised.slice(start, end)) : null;
    if (found.kind === 'statistic' && !symbol) return false;
    if (found.kind === 'decimal' || found.kind === 'statistic') {
      if (LEVEL_BEFORE.test(before) || LEVEL_AFTER.test(after)) return true;
      if (symbol && /[<≤]/.test(symbol[2]!) && CONSIDERED_AFTER.test(after)) return true;
    }
  }
  return found.kind === 'decimal' && COMPARATOR_BEFORE.test(before) && THRESHOLD_WORDS.test(sentenceAround(normalised, start, end));
}

function overlaps(start: number, end: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([from, to]) => start < to && from < end);
}

function span(original: string, start: number, end: number, value: string, kind: NumberSpan['kind']): NumberSpan {
  /* Offsets are trimmed to the span itself: "r = .45 " → "r = .45". */
  const raw = original.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  return { text: trimmed, index: start + lead, length: trimmed.length, value, kind };
}

/**
 * Research numbers in `text`, in text order, before any allowed set is
 * applied. `strict`: every digit run outside a token. Otherwise the P1-C
 * detector (statistic assignments, decimals, percentages), with a decimal
 * inside an assignment reported once as part of it, and labels and numbered
 * headings excluded as ordinary.
 */
export function researchNumbers(text: string, mode: IntegrityMode): NumberSpan[] {
  const normalised = readable(text);
  if (mode === 'strict') {
    return [...normalised.matchAll(/\d[\d.,]*/g)].map((match) => span(text, match.index, match.index + match[0].length, normaliseValue(match[0]), 'digit'));
  }

  const spans: NumberSpan[] = [];
  const taken: [number, number][] = [];
  for (const match of normalised.matchAll(ASSIGNMENT)) {
    const end = match.index + match[0].length;
    const value = /[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.exec(match[0])?.[0] ?? match[0];
    spans.push(span(text, match.index, end, normaliseValue(value), 'statistic'));
    taken.push([match.index, end]);
  }
  const ordinary = ordinaryRanges(normalised);
  for (const match of normalised.matchAll(DECIMAL)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(start, end, taken) || overlaps(start, end, ordinary)) continue;
    const percent = match[0].includes('%');
    spans.push(span(text, start, end, normaliseValue(match[0].replace(/\s?%$/, '')), percent ? 'percent' : 'decimal'));
  }
  return spans.filter((found) => !isStatedCriterion(normalised, found)).sort((a, b) => a.index - b.index);
}

/** Checks the research numbers in `text` against the allowed values, under `mode`. */
export function checkNumbers(text: string, options: CheckOptions): NumberCheck {
  const spans = researchNumbers(text, options.mode);
  if (options.mode === 'strict') {
    return { mode: 'strict', guardVersion: NUMERIC_GUARD_VERSION, findings: spans, traced: [], clean: spans.length === 0 };
  }
  const allowed = new Set([...(options.allowed ?? []), ...contextNumbers(options.context ?? [])]);
  const findings: NumberSpan[] = [];
  const traced: NumberSpan[] = [];
  for (const found of spans) (isAllowed(found.value, allowed) ? traced : findings).push(found);
  return { mode: options.mode, guardVersion: NUMERIC_GUARD_VERSION, findings, traced, clean: findings.length === 0 };
}

/* -------------------------------------------------------------------------- */
/*                                 Quarantine                                 */
/* -------------------------------------------------------------------------- */

export const QUARANTINE_MARKER = { en: '⟦unverified value⟧', ar: '⟦قيمة غير موثّقة⟧' } as const;

/**
 * Model text with every untraced research number replaced by a visible
 * marker (never silently dropped). Only for model text: a person's words are
 * reported, never rewritten. The marker carries no digit, so the result
 * checks clean under the same options.
 */
export function quarantine(text: string, check: NumberCheck, locale: 'en' | 'ar' = 'en'): { text: string; quarantined: number } {
  if (check.mode === 'person') throw new Error('A person’s text is reported, never rewritten.');
  const marker = QUARANTINE_MARKER[locale];
  let out = text;
  for (const found of [...check.findings].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, found.index) + marker + out.slice(found.index + found.length);
  }
  return { text: out, quarantined: check.findings.length };
}

/* -------------------------------------------------------------------------- */
/*                            Legacy result tiers                             */
/* -------------------------------------------------------------------------- */

/**
 * How reproducible a legacy analysis result is, from what it recorded. None of
 * these is "verified" (only P1-C statistics runs are):
 * - `pinned`: dataset version, content hash and engine recorded, whole file;
 * - `windowed`: computed on the first rows only (`spec.truncatedTo`);
 * - `unpinned`: the exact data is not recorded (runs before P1-C).
 */
export type LegacyResultTier = 'pinned' | 'windowed' | 'unpinned';

export function legacyResultTier(run: { datasetVersionId?: string | null; datasetContentHash?: string | null; engineVersion?: string | null; spec?: unknown }): LegacyResultTier {
  const spec = (run.spec ?? {}) as { truncatedTo?: unknown };
  if (typeof spec.truncatedTo === 'number' && spec.truncatedTo > 0) return 'windowed';
  return run.datasetVersionId && run.datasetContentHash && run.engineVersion ? 'pinned' : 'unpinned';
}
