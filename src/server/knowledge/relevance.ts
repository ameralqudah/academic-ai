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
  تعليم: 'تعلم',
  تعلم: 'تعلم',
  مدمج: 'هجين',
  هجين: 'هجين',
  مدونه: 'مدونه',
  education: 'learning',
  learning: 'learning',
  blended: 'hybrid',
  hybrid: 'hybrid',
};

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

  const normalisedTerms = terms.map(normalise);

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

    return matchOn.some((term) => haystack.includes(term));
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
  const rarest = normalisedTerms
    .map((term) => ({
      term,
      count: sources.filter((source) =>
        normalise(`${source.title ?? ''} ${source.snippet ?? ''}`)
          .split(/\s+/)
          .map((word) => canonical(stripArabicPrefix(word)))
          .join(' ')
          .includes(term),
      ).length,
    }))
    .sort((a, b) => a.count - b.count)[0];

  return (rarest?.count ?? 0) < sources.length / 3;
}
