/**
 * Discarding results that do not answer the question.
 *
 * A researcher asked for studies on hybrid learning (التعلم الهجين) and
 * received ten papers about learning disabilities. The provider was working as
 * documented: Crossref's index for Arabic is shallow, and a two-word Arabic
 * phrase matches anything containing the commoner word. Switching to
 * `query.bibliographic` helped and did not fix it.
 *
 * So relevance is checked here, after retrieval, against the text we actually
 * received. A provider that cannot tell "التعلم الهجين" from "صعوبات التعلم"
 * hands back both; this decides which one was asked for.
 *
 * **The bar is deliberately low.** Discarding a relevant source is worse than
 * keeping an irrelevant one: the researcher can ignore what does not fit, but
 * cannot recover what they never saw. So a single meaningful term is enough,
 * and everything ambiguous is kept.
 *
 * **What it does not do is rank.** Ordering results by a similarity score
 * invented here would override the provider's own relevance ranking, which is
 * built on citation graphs and full text this has no access to.
 */

import type { Source } from './types';

/**
 * Words too common to carry meaning.
 *
 * A query is filtered down to its distinctive terms before matching, because
 * "دراسات عن التعلم" would otherwise match on "دراسات" — which appears in half
 * the corpus and says nothing about the topic.
 */
const ARABIC_STOPWORDS = new Set([
  'في', 'من', 'على', 'عن', 'إلى', 'الى', 'مع', 'هذا', 'هذه', 'ذلك',
  'التي', 'الذي', 'ما', 'أن', 'إن', 'كان', 'بين', 'حول', 'بعد', 'قبل',
  'دراسة', 'دراسات', 'بحث', 'بحوث', 'أبحاث', 'مراجعة', 'حديثة', 'حديث',
  'أثر', 'تأثير', 'دور', 'واقع', 'تقييم', 'تحليل',
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'and', 'or', 'to', 'with',
  'about', 'from', 'by', 'at', 'as', 'is', 'are', 'was', 'were',
  'study', 'studies', 'research', 'review', 'recent', 'effect', 'impact',
  'role', 'analysis', 'assessment',
]);

/**
 * The terms a query is actually about.
 *
 * Arabic prefixes are stripped — "التعلم" and "تعلم" and "بالتعلم" are the same
 * word to a reader and different strings to a matcher, and a filter that missed
 * that would discard every correct result.
 */
export function meaningfulTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => stripArabicPrefix(word))
    .filter(
      (word) =>
        word.length >= 3 && !ARABIC_STOPWORDS.has(word) && !ENGLISH_STOPWORDS.has(word),
    );
}

/**
 * Removes the definite article and common prefixes.
 *
 * Only the prefixes that are unambiguously grammatical. Stripping more would
 * turn "بحث" into "حث" and match the wrong things — an aggressive stemmer does
 * more damage here than none at all.
 */
function stripArabicPrefix(word: string): string {
  if (!/^[\u0600-\u06FF]/.test(word)) return word;

  /* Long enough that removing two letters still leaves a root. */
  if (word.length > 5) {
    for (const prefix of ['وال', 'بال', 'كال', 'فال', 'لل']) {
      if (word.startsWith(prefix)) return word.slice(prefix.length);
    }
  }

  if (word.length > 4 && word.startsWith('ال')) return word.slice(2);

  return word;
}

/**
 * Word pairs a researcher means interchangeably.
 *
 * "التعلم" and "التعليم" are different words — learning and education — and a
 * researcher searching for one wants papers using the other. Kept as an
 * explicit list rather than a stemmer: an aggressive stemmer would collapse
 * "بحث" and "حث", which mean different things and would match the wrong corpus.
 *
 * Deliberately short. Every entry is a claim that two words are equivalent, and
 * a wrong claim silently changes what a search returns.
 */
const EQUIVALENTS: Record<string, string> = {
  تعليم: 'learning',
  تعلم: 'learning',
  learning: 'learning',
  education: 'learning',
  تعلّم: 'learning',

  هجين: 'hybrid',
  مدمج: 'hybrid',
  hybrid: 'hybrid',
  blended: 'hybrid',
};

/**
 * Words whose meaning depends entirely on what follows them.
 *
 * "Hybrid" is the clearest case: it modifies learning, matrix-ensembles,
 * control strategies and machine learning with no shared subject between them.
 * A search for hybrid learning returned papers on kidney disease and robotics
 * because "hybrid" was the rarest word in the query, and rarity is why the
 * filter trusted it.
 *
 * Terms listed here cannot carry a match alone. They still count towards
 * coverage — the phrase they belong to is what the researcher asked for — but
 * a source matching only these has matched a modifier, not a topic.
 */
const MODIFIERS = new Set([
  'hybrid', 'blended', 'smart', 'digital', 'modern', 'advanced', 'novel',
  'improved', 'enhanced', 'integrated', 'adaptive', 'intelligent',
  'هجين', 'مدمج', 'ذكي', 'رقمي', 'حديث', 'متقدم', 'مطور', 'متكامل',
]);

/** Maps a term to its canonical form, when one is declared. */
function canonical(word: string): string {
  return EQUIVALENTS[word] ?? word;
}

/** Normalises Arabic letter variants that a search should treat as equal. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064b-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

export interface RelevanceResult {
  kept: Source[];
  /** How many were discarded, so the caller can say the search was narrow. */
  discarded: number;
}

/**
 * Keeps the sources that plausibly concern the query.
 *
 * A source is kept when a meaningful term from the query appears in its title
 * or abstract. One term is enough — a paper on "التعلم الهجين في الجامعات"
 * matches on "الهجين" alone, and requiring both would discard it for using a
 * synonym in the other position.
 */
export function filterByRelevance(sources: Source[], query: string): RelevanceResult {
  const terms = meaningfulTerms(query);

  /*
   * A query with no distinctive terms — "recent studies" — cannot be filtered
   * on. Returning everything is correct: the researcher gave nothing to match
   * against, and inventing a criterion would discard arbitrarily.
   */
  if (terms.length === 0) return { kept: sources, discarded: 0 };

  /*
   * Canonicalised, so an Arabic query matches an English title of the same
   * subject. "التعلم الهجين" and "hybrid learning" name one topic, and a
   * researcher asking in Arabic wants the English literature too — leaving the
   * query in its own script made every comparison fail silently.
   */
  const normalisedTerms = terms.map((term) => canonical(normalise(stripArabicPrefix(term))));

  /*
   * The distinctive term decides, not any term.
   *
   * "التعلم الهجين" reduces to "تعلم" and "هجين". Matching on either kept six
   * papers about learning disabilities, because "تعلم" appears in all of them —
   * the common word carries no information about the topic and the rare one
   * carries all of it.
   *
   * So a term appearing in most results is treated as noise: if half the corpus
   * contains it, it did not distinguish anything. What remains must match.
   */
  const canonicalise = (text: string) =>
    normalise(text)
      .split(/\s+/)
      .map((word) => canonical(stripArabicPrefix(word)))
      .join(' ');

  const distinctive = normalisedTerms.filter((term) => {
    const appearing = sources.filter((source) =>
      canonicalise(`${source.title ?? ''} ${source.snippet ?? ''}`).includes(term),
    ).length;

    return appearing <= sources.length / 2;
  });

  /*
   * Every term was common, so none distinguishes. Falling back to matching any
   * of them is right: the alternative is discarding everything on a criterion
   * that failed to separate them.
   */
  const matchOn = distinctive.length > 0 ? distinctive : normalisedTerms;

  /*
   * A single shared word is not a topic.
   *
   * A search for "hybrid learning" returned papers on hybrid matrix-ensembles
   * for kidney disease, hybrid control strategies for robots, and hybrid
   * machine learning for spatial databases. Every one matched on "hybrid", the
   * rarest word in the query and therefore the one the filter trusted most.
   *
   * The rarest word is the right thing to rank by and the wrong thing to
   * *decide* by: "hybrid" is rare in this corpus precisely because it is a
   * generic technical modifier that attaches to anything. So a source must
   * cover enough of the query, not merely its most distinctive fragment.
   */
  const required = coverageRequired(normalisedTerms.length);

  const kept = sources.filter((source) => {
    /*
     * Every word in the title is canonicalised too, so "التعليم الهجين" matches
     * a search for "التعلم الهجين" — the researcher means both.
     */
    const haystack = normalise(
      `${source.title ?? ''} ${source.snippet ?? ''} ${source.container ?? ''}`,
    )
      .split(/\s+/)
      .map((word) => canonical(stripArabicPrefix(word)))
      .join(' ');

    /*
     * Counted over every meaningful term, not only the distinctive ones. A
     * paper about hybrid learning contains both words; a paper about hybrid
     * robotics contains one, and one is what let it through.
     */
    const present = normalisedTerms.filter((term) => haystack.includes(term));

    /*
     * A modifier cannot carry a match by itself. "Hybrid machine learning for
     * spatial databases" contains both query words and is not about hybrid
     * learning — the subject word must be there on its own terms.
     */
    const substantive = present.filter((term) => !MODIFIERS.has(term));

    if (present.length >= required && substantive.length > 0) return true;

    /*
     * A distinctive term still earns a place when the query has only one
     * meaningful word — "photosynthesis" cannot be asked to match two things.
     */
    /*
     * A single-word query can only ask for itself, so one match is the whole
     * of it — unless that word is a modifier, which asks for nothing.
     */
    return (
      normalisedTerms.length <= 1 &&
      !MODIFIERS.has(normalisedTerms[0] ?? '') &&
      matchOn.some((term) => haystack.includes(term))
    );
  });

  /*
   * If filtering removed everything, the unfiltered set is returned.
   *
   * Zero results tells the researcher nothing and hides what the provider did
   * find; ten imperfect ones let them judge. The caller is told how weak the
   * match was so it can say so rather than presenting them as answers.
   */
  if (kept.length === 0) return { kept: sources, discarded: 0 };

  return { kept, discarded: sources.length - kept.length };
}

/**
 * How many of a query's terms a source must contain.
 *
 * One word can only ask for itself. Two must both appear — "hybrid learning"
 * means both, and accepting either is what admitted the robotics papers. Longer
 * queries relax, because a five-word phrase rarely appears whole in a title and
 * demanding all five would discard the relevant along with the rest.
 */
function coverageRequired(termCount: number): number {
  if (termCount <= 1) return 1;
  if (termCount === 2) return 2;
  if (termCount <= 4) return 2;

  return Math.ceil(termCount * 0.5);
}

/**
 * Whether the results plausibly answer the query at all.
 *
 * Used to warn rather than to filter. A search where most results match nothing
 * is a search whose phrasing found the wrong corpus, and telling the researcher
 * that is more useful than handing them ten papers on another subject as though
 * they were an answer.
 */
export function looksOffTopic(sources: Source[], query: string): boolean {
  const terms = meaningfulTerms(query);
  if (terms.length === 0 || sources.length === 0) return false;

  const normalisedTerms = terms.map((term) => normalise(canonical(term)));

  /*
   * Judged on the rarest term, for the same reason. A search where the
   * distinctive word appears nowhere found the wrong corpus, however many
   * results contain the common one.
   */
  /*
   * Judged on how many sources cover the query, not on the rarest word.
   *
   * The rarest word was "hybrid", which appeared in every result — including
   * the papers about kidney disease — so the corpus looked on-topic while being
   * entirely wrong. Coverage answers the question actually being asked: do
   * these sources concern the subject, or do they share a word with it?
   */
  const required = coverageRequired(normalisedTerms.length);

  const covering = sources.filter((source) => {
    const haystack = normalise(`${source.title ?? ''} ${source.snippet ?? ''}`)
      .split(/\s+/)
      .map((word) => canonical(stripArabicPrefix(word)))
      .join(' ');

    return normalisedTerms.filter((term) => haystack.includes(term)).length >= required;
  });

  return covering.length < sources.length / 3;
}
