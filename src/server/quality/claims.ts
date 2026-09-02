/**
 * Which sentences need a source, and which do not.
 *
 * The crude version of this rule — every sentence must cite something — was
 * rejected for good reason. It would flag "This chapter presents the
 * methodology", "Therefore, the second hypothesis is supported", and every
 * transition a person writes to hold a document together. A checker that
 * objects to half of good academic prose is a checker researchers turn off.
 *
 * So the question is not "is this cited" but "does this need to be". Four
 * categories, and only the first two do:
 *
 * - **Empirical claims** — findings, statistics, proportions, effects,
 *   attributions to other researchers. These carry the weight of the argument
 *   and are exactly what gets invented when a model writes unsupported.
 * - **Current or external facts** — anything about the present state of the
 *   world, which the model cannot know reliably.
 * - **Connective and procedural writing** — transitions, signposting,
 *   restatement, structure. Needs nothing.
 * - **The author's own reasoning** — interpretation, argument, limitations.
 *   Should not be cited, because it is the researcher's contribution.
 *
 * **Nothing here rewrites or deletes.** A flag says "this asserts something
 * external and names no source", which the researcher resolves by adding a
 * citation, softening the claim, or dismissing the flag because it is their own
 * data. All three are legitimate and only they can choose.
 */

export type ClaimKind =
  /** A finding, statistic or attribution. Needs a source. */
  | 'empirical'
  /** A fact about the world that could have changed. Needs a source. */
  | 'external-fact'
  /** A transition, heading, or statement about the document. Needs nothing. */
  | 'connective'
  /** The author's interpretation or argument. Should not be cited. */
  | 'authorial'
  /** Content the user supplied. Not the generator's to justify. */
  | 'user-provided';

export interface Claim {
  /** The sentence, as written. */
  text: string;
  kind: ClaimKind;
  /** Citation markers found in it: `[3]`, `(Smith, 2020)`. */
  citations: string[];
  /** Character offset, so an interface can point at it. */
  offset: number;
  needsSource: boolean;
}

export interface ClaimAnalysis {
  claims: Claim[];
  /** Claims needing a source that have none. The finding that matters. */
  unsupported: Claim[];
  /** Proportion of claims needing support that have it. */
  coverage: number;
  /** Every distinct citation marker used in the text. */
  citedIds: string[];
}

/*
 * Citation forms this recognises.
 *
 * Numeric brackets and author-year, which between them cover APA, IEEE,
 * Harvard, Chicago author-date, and the Arabic conventions built on them.
 * Footnote styles are not detected, and that limitation is stated rather than
 * papered over: a document using Chicago notes will report zero coverage, and
 * the report says so instead of implying the citations are missing.
 */
const CITATION_PATTERNS = [
  /\[(\d+(?:\s*[,،-]\s*\d+)*)\]/g,
  /\((?:[A-Z][\p{L}'’-]+|[\u0600-\u06FF][\u0600-\u06FF\s]+?)(?:\s+(?:et al\.?|وآخرون|and\s+[A-Z][\p{L}'’-]+|&\s*[A-Z][\p{L}'’-]+))?,\s*(?:\d{4}|\d{4}[a-z])\)/gu,
];

/**
 * Splits prose into sentences and classifies each.
 *
 * Sentence splitting on Arabic and English together, which is why the
 * terminators include the Arabic question mark and the full stop is not
 * assumed to be the only boundary.
 */
export function analyseClaims(
  text: string,
  options: { userProvidedRanges?: { start: number; end: number }[] } = {},
): ClaimAnalysis {
  const claims: Claim[] = [];
  const citedIds = new Set<string>();

  for (const { sentence, offset } of splitSentences(text)) {
    const citations = findCitations(sentence);
    for (const id of citations) citedIds.add(id);

    const userProvided = (options.userProvidedRanges ?? []).some(
      (range) => offset >= range.start && offset < range.end,
    );

    const kind = userProvided ? 'user-provided' : classify(sentence);

    claims.push({
      text: sentence,
      kind,
      citations,
      offset,
      needsSource: kind === 'empirical' || kind === 'external-fact',
    });
  }

  const needing = claims.filter((claim) => claim.needsSource);
  const supported = needing.filter((claim) => claim.citations.length > 0);

  return {
    claims,
    unsupported: needing.filter((claim) => claim.citations.length === 0),
    /*
     * Coverage over claims that need support, not over all sentences. A
     * document that is 40% transitions should not be reported as 60% cited —
     * that number would be about its writing style rather than its evidence.
     */
    coverage: needing.length === 0 ? 1 : supported.length / needing.length,
    citedIds: [...citedIds],
  };
}

/**
 * What kind of statement a sentence is.
 *
 * Ordered so that the categories needing nothing are recognised first. A
 * sentence that announces the document's structure is connective even if it
 * mentions a percentage, and testing that first avoids flagging "Chapter four
 * reports the 68% response rate" as an uncited statistic.
 */
function classify(sentence: string): ClaimKind {
  const text = sentence.trim();

  if (text.length < 15) return 'connective';

  /* Headings and numbered structure. */
  if (/^#{1,6}\s/.test(text) || /^\d+(\.\d+)*\s+\S/.test(text)) return 'connective';

  if (isConnective(text)) return 'connective';
  if (isAuthorial(text)) return 'authorial';
  if (isEmpirical(text)) return 'empirical';
  if (isExternalFact(text)) return 'external-fact';

  /*
   * Anything else is treated as the author's own writing.
   *
   * The default matters: defaulting to `empirical` would flag every
   * unrecognised sentence, and a report full of false flags gets ignored
   * wholesale — including the true ones. Missing a real unsupported claim is
   * bad; making the whole report untrustworthy is worse.
   */
  return 'authorial';
}

/** Statements about the document rather than about the world. */
function isConnective(text: string): boolean {
  return (
    /^(this|the following|the next|the previous|in this|as (shown|discussed|noted|mentioned)|table \d|figure \d)\b/i.test(
      text,
    ) ||
    /^(هذا|هذه|يتناول هذا|يعرض هذا|في هذا|كما (ورد|ذُكر|هو مبيّن)|الجدول \d|الشكل \d|يوضّح الجدول|يبيّن الشكل)/.test(
      text,
    ) ||
    /^(first|second|third|finally|next|then|moreover|furthermore|however|therefore|in summary|to summarise|in conclusion)\b/i.test(
      text,
    ) ||
    /^(أولًا|ثانيًا|ثالثًا|أخيرًا|كذلك|علاوة على ذلك|ومن ثم|وبناءً على ذلك|وخلاصة القول|وفي الختام)/.test(
      text,
    )
  );
}

/** The researcher's own interpretation, which should not be cited. */
function isAuthorial(text: string): boolean {
  return (
    /\b(we|i|this study|the present study|our (findings|results|analysis|study))\b/i.test(text) ||
    /(هذه الدراسة|الدراسة الحالية|نتائج هذه الدراسة|نستنتج|نرى أن|يرى الباحث|تشير نتائجنا)/.test(
      text,
    ) ||
    /\b(suggests? that (this|these)|may (indicate|explain|reflect)|one (possible )?explanation)\b/i.test(
      text,
    )
  );
}

/**
 * A finding, a statistic, or an attribution to other work.
 *
 * These are what gets invented. A sentence reporting that something increased
 * by 34% or that a study found an effect is making a checkable claim, and a
 * reader is entitled to know where it came from.
 */
function isEmpirical(text: string): boolean {
  return (
    /\b(found|showed|demonstrated|reported|revealed|concluded|observed|indicated)\s+that\b/i.test(
      text,
    ) ||
    /(أظهرت|أشارت|وجدت|كشفت|بيّنت|أثبتت|توصّلت)\s+(الدراسة|الدراسات|النتائج|الأبحاث|البحوث)/.test(
      text,
    ) ||
    /\b(according to|studies (show|indicate|suggest)|research (shows|indicates|suggests)|evidence (shows|suggests))\b/i.test(
      text,
    ) ||
    /(وفقًا لـ|تشير الدراسات|تؤكّد الأبحاث|أفادت دراسة)/.test(text) ||
    /\d+(\.\d+)?\s*[%٪]/.test(text) ||
    /\b(p\s*[<>=]\s*\.?\d|r\s*=\s*[-.\d]|β\s*=|significant(ly)? (higher|lower|different|correlated))\b/i.test(
      text,
    ) ||
    /\b(meta-analysis|systematic review|randomised controlled trial|sample of \d+)\b/i.test(text)
  );
}

/**
 * A fact about the world that could have changed since training.
 *
 * Separated from empirical claims because the remedy differs: an empirical
 * claim wants an academic citation, and a current fact wants a source that was
 * checked recently — which is what web search exists for.
 */
function isExternalFact(text: string): boolean {
  return (
    /\b(currently|as of \d{4}|in \d{4},|the (largest|leading|first|only)\b)/i.test(text) ||
    /(حاليًا|في عام \d{4}|اعتبارًا من|الأكبر|الأول|الوحيد في)/.test(text) ||
    /\b(is|are|has|have)\s+(the\s+)?(largest|smallest|highest|lowest|most|leading)\b/i.test(text)
  );
}

/** Citation markers in a sentence, normalised to bare ids. */
export function findCitations(text: string): string[] {
  const found: string[] = [];

  for (const pattern of CITATION_PATTERNS) {
    /* The global flag carries state between calls; reset before each use. */
    pattern.lastIndex = 0;

    let match = pattern.exec(text);
    while (match) {
      const inner = match[1];

      if (inner && /^\d/.test(inner)) {
        /* `[1, 3-5]` is three citations, not one. */
        for (const part of inner.split(/[,،]/)) {
          const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);

          if (range) {
            const from = Number(range[1]);
            const to = Number(range[2]);
            for (let n = from; n <= to && n - from < 50; n += 1) found.push(String(n));
          } else if (part.trim()) {
            found.push(part.trim());
          }
        }
      } else {
        found.push(match[0].slice(1, -1).trim());
      }

      match = pattern.exec(text);
    }
  }

  return [...new Set(found)];
}

/** Sentences with their offsets, across Arabic and English punctuation. */
function splitSentences(text: string): { sentence: string; offset: number }[] {
  const results: { sentence: string; offset: number }[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    const isTerminator = char === '.' || char === '!' || char === '?' || char === '؟' || char === '\n';

    if (!isTerminator) continue;

    /*
     * A full stop inside a decimal, an abbreviation, or a DOI is not a sentence
     * boundary. Splitting on those turns "p < 0.05" into two fragments and
     * every citation in the second one goes missing.
     */
    if (char === '.') {
      const before = text[i - 1] ?? '';
      const after = text[i + 1] ?? '';
      if (/\d/.test(before) && /\d/.test(after)) continue;
      if (/[A-Z]/.test(before) && (after === ' ' || after === '')) continue;
    }

    const sentence = text.slice(start, i + 1).trim();
    if (sentence.length > 0) results.push({ sentence, offset: start });
    start = i + 1;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) results.push({ sentence: tail, offset: start });

  return results;
}
