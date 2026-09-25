/**
 * Output-side academic integrity checks.
 *
 * The system prompt asks the model not to fabricate sources. This layer assumes
 * it sometimes will anyway, finds what looks like a citation, and flags it so the
 * UI can mark it unverified. Nothing here silently rewrites the model's text —
 * the researcher must see what was flagged.
 */

import { allowedSpellings, checkNumbers, QUARANTINE_MARKER, type ScopedValues } from '@/server/integrity/numbers';

export type GuardrailFlag =
  | 'UNVERIFIED_CITATION'
  | 'DOI_PRESENT'
  | 'EXTERNAL_URL'
  | 'CLAIMED_EXPERIMENT'
  | 'FABRICATED_STATISTIC'
  /** A number in a results section that matches none of the analyses attached to it (P1-C). */
  | 'UNTRACED_STATISTIC';

export interface GuardrailFinding {
  flag: GuardrailFlag;
  /** The matched fragment, trimmed for display. */
  sample: string;
}

export interface GuardrailResult {
  flags: GuardrailFlag[];
  findings: GuardrailFinding[];
  /** A short bilingual notice to show under the output, or null when clean. */
  notice: { en: string; ar: string } | null;
}

const DOI_PATTERN = /\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)10\.\d{4,9}\/\S+/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s)>\]]+/gi;

/** `(Smith, 2019)` / `(سميث، 2019)` / `Smith (2019)` / `الزهراني (2021)` */
const CITATION_PATTERN =
  /(\([^()]{2,60}[,،]\s*(?:19|20)\d{2}[a-z]?\s*\))|([\p{Letter}][\p{Letter}\s.'-]{2,40}\s\((?:19|20)\d{2}[a-z]?\))/gu;

const EXPERIMENT_CLAIMS =
  /\b(I (?:ran|conducted|performed|collected|analy[sz]ed)|we (?:ran|conducted|performed|collected|analy[sz]ed))\b|\b(قمت بإجراء|أجرينا|قمنا بجمع|حللت البيانات)\b/gi;

function sample(match: string): string {
  const trimmed = match.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function collect(
  text: string,
  pattern: RegExp,
  flag: GuardrailFlag,
  limit = 5,
): GuardrailFinding[] {
  const findings: GuardrailFinding[] = [];
  const matches = text.matchAll(pattern);
  for (const match of matches) {
    findings.push({ flag, sample: sample(match[0]) });
    if (findings.length >= limit) break;
  }
  return findings;
}

export interface InspectOptions {
  /** Sections that must not contain numeric findings unless the user supplied data. */
  expectsNoStatistics?: boolean;
  /**
   * For results sections: every number the analyses attached to the section
   * contain (windowed runs excluded, WS2 D3), as the text may write them. A
   * statistic in the text that is not one of them is flagged as untraced
   * (P1-C: the check used to be off exactly where numbers belong).
   */
  verifiedNumbers?: ReadonlySet<string> | ScopedValues;
  /** Text the user supplied (their instruction, project metadata): numbers in it are theirs, not findings (WS2). */
  context?: readonly string[];
  /** How many untraced numbers were replaced by the quarantine marker before saving (WS2 N1); the notice says so. */
  quarantined?: number;
}

/**
 * Numeric spellings a stored value may appear as: 0.4567 → "0.457", ".457", "0.46", ".46", "45.67%"…
 * The canonical implementation is the WS2 guard's (`@/server/integrity/numbers`).
 */
export const numberSpellings = allowedSpellings;

/*
 * Statistic-like numbers are found by the canonical numeric-integrity guard
 * (WS2): the P1-C detector, with labels such as "Table 2.1" and numbered
 * headings treated as ordinary. This module only turns its findings into
 * flags; it never rewrites the text.
 */
function statisticFindings(text: string, flag: 'FABRICATED_STATISTIC' | 'UNTRACED_STATISTIC', allowed: ReadonlySet<string> | ScopedValues, context: readonly string[] | undefined, limit = 5): GuardrailFinding[] {
  return checkNumbers(text, { mode: 'model', allowed, context })
    .findings.slice(0, limit)
    .map((found) => ({ flag, sample: sample(found.text) }));
}

export function inspectOutput(text: string, options: InspectOptions = {}): GuardrailResult {
  const findings: GuardrailFinding[] = [
    ...collect(text, DOI_PATTERN, 'DOI_PRESENT'),
    ...collect(text, CITATION_PATTERN, 'UNVERIFIED_CITATION'),
    ...collect(text, URL_PATTERN, 'EXTERNAL_URL', 3),
    ...collect(text, EXPERIMENT_CLAIMS, 'CLAIMED_EXPERIMENT', 3),
    ...(options.expectsNoStatistics ? statisticFindings(text, 'FABRICATED_STATISTIC', new Set(), options.context) : []),
    ...(options.verifiedNumbers ? statisticFindings(text, 'UNTRACED_STATISTIC', options.verifiedNumbers, options.context) : []),
  ];

  const flags = [...new Set(findings.map((finding) => finding.flag))];

  return { flags, findings, notice: noticeFor(flags, options.quarantined ?? 0) };
}

function noticeFor(flags: GuardrailFlag[], quarantined: number): GuardrailResult['notice'] {
  if (flags.length === 0 && quarantined === 0) return null;

  const parts: { en: string; ar: string }[] = [];

  if (quarantined > 0) {
    parts.push({
      en: `${quarantined} ${quarantined === 1 ? 'number' : 'numbers'} could not be traced to your analyses or your instruction and ${quarantined === 1 ? 'was' : 'were'} replaced with ${QUARANTINE_MARKER.en}. Enter the real values from your own analysis.`,
      ar: `تعذّر تتبّع ${quarantined === 1 ? 'رقم واحد' : `${quarantined} أرقام`} إلى تحليلاتك أو تعليماتك، فاستُبدل بـ ${QUARANTINE_MARKER.ar}. أدخل القيم الحقيقية من تحليلك.`,
    });
  }

  if (flags.includes('UNVERIFIED_CITATION') || flags.includes('DOI_PRESENT')) {
    parts.push({
      en: 'This text contains citation-like references. They are unverified — open each source and confirm it before using it.',
      ar: 'يحتوي هذا النص على ما يشبه الاستشهادات المرجعية. إنها غير متحقَّق منها — افتح كل مصدر وتأكد منه قبل استخدامه.',
    });
  }

  if (flags.includes('FABRICATED_STATISTIC')) {
    parts.push({
      en: 'Numeric findings appear in a section that should not contain results. Replace them with your own analysis.',
      ar: 'ظهرت نتائج رقمية في قسم لا ينبغي أن يتضمن نتائج. استبدلها بتحليلك أنت.',
    });
  }

  if (flags.includes('UNTRACED_STATISTIC')) {
    parts.push({
      en: 'Some numbers here do not match any analysis attached to this section. Replace them with values from your own analyses, or insert verified values from the analysis workbench.',
      ar: 'بعض الأرقام هنا لا تطابق أي تحليل مرفق بهذا القسم. استبدلها بقيم من تحليلاتك، أو أدرج قيمًا موثّقة من منصة التحليل.',
    });
  }

  if (flags.includes('CLAIMED_EXPERIMENT')) {
    parts.push({
      en: 'The text implies research was carried out by the assistant. Rewrite those sentences in your own voice.',
      ar: 'يوحي النص بأن المساعد أجرى بحثًا. أعد صياغة تلك الجمل بصوتك أنت.',
    });
  }

  if (parts.length === 0) return null;

  return {
    en: parts.map((part) => part.en).join(' '),
    ar: parts.map((part) => part.ar).join(' '),
  };
}

/**
 * Parses the JSON payload a prompt asked for, tolerating the code fences models
 * sometimes wrap it in. Returns null instead of throwing so callers can decide.
 */
export function parseJsonOutput<T>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
