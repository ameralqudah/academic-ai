/**
 * Output-side academic integrity checks.
 *
 * The system prompt asks the model not to fabricate sources. This layer assumes
 * it sometimes will anyway, finds what looks like a citation, and flags it so the
 * UI can mark it unverified. Nothing here silently rewrites the model's text —
 * the researcher must see what was flagged.
 */

export type GuardrailFlag =
  | 'UNVERIFIED_CITATION'
  | 'DOI_PRESENT'
  | 'EXTERNAL_URL'
  | 'CLAIMED_EXPERIMENT'
  | 'FABRICATED_STATISTIC';

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

/** Precise-looking statistics are the classic hallucination in a results section. */
const STATISTIC_PATTERN =
  /\b(?:p\s*[<=>]\s*0?\.\d+|r\s*=\s*-?0?\.\d+|(?:F|t|χ2|chi-square)\s*\(?\d|\d{1,3}(?:\.\d+)?\s?%\s*(?:of|من))/gi;

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
}

export function inspectOutput(text: string, options: InspectOptions = {}): GuardrailResult {
  const findings: GuardrailFinding[] = [
    ...collect(text, DOI_PATTERN, 'DOI_PRESENT'),
    ...collect(text, CITATION_PATTERN, 'UNVERIFIED_CITATION'),
    ...collect(text, URL_PATTERN, 'EXTERNAL_URL', 3),
    ...collect(text, EXPERIMENT_CLAIMS, 'CLAIMED_EXPERIMENT', 3),
    ...(options.expectsNoStatistics
      ? collect(text, STATISTIC_PATTERN, 'FABRICATED_STATISTIC', 5)
      : []),
  ];

  const flags = [...new Set(findings.map((finding) => finding.flag))];

  return { flags, findings, notice: noticeFor(flags) };
}

function noticeFor(flags: GuardrailFlag[]): GuardrailResult['notice'] {
  if (flags.length === 0) return null;

  const parts: { en: string; ar: string }[] = [];

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
