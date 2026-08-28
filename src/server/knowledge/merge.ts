/**
 * Combining results from several providers into one ranked list.
 *
 * Three jobs, and the second is the one that makes the whole layer worth
 * having.
 *
 * **Deduplication by DOI.** The same paper comes back from Crossref and
 * OpenAlex described differently — different title casing, different abstract,
 * different URL — with one identifier in common. Without this, a researcher
 * asking for ten sources gets six papers and four duplicates, and the
 * duplicates look like independent corroboration. Matching on the DOI rather
 * than the title is what makes it reliable.
 *
 * **Ranking across incomparable scores.** Crossref's relevance score and
 * OpenAlex's are both called "score" and are on entirely different scales —
 * 18.5 and 6254.3 in the responses we sampled. Ranking on them directly would
 * mean OpenAlex always wins. So provider scores are used only to order within a
 * provider, and the cross-provider ranking is built from things that mean the
 * same everywhere.
 *
 * **Reporting the Arabic coverage honestly.** This is a requirement rather than
 * a nicety. Arabic-language scholarship is structurally under-indexed in the
 * open bibliographic databases: most Arabic journals do not issue DOIs, so they
 * never enter Crossref, so they never reach OpenAlex. A search that returns
 * only English results is not evidence that no Arabic research exists — it is
 * mostly evidence about the index. Saying so is the difference between a tool
 * that informs a researcher and one that quietly misleads them.
 */

import type { Source, SourceLanguage } from './types';

export interface MergeInput {
  sources: Source[];
  /** The language the user is working in — matching sources rank higher. */
  preferredLanguage: SourceLanguage;
  limit?: number;
}

export interface CoverageReport {
  total: number;
  byLanguage: { ar: number; en: number; other: number };
  byProvider: Record<string, number>;
  duplicatesRemoved: number;
  /**
   * Set when the Arabic results are thin enough that saying so matters.
   *
   * A message key rather than a sentence, so the interface says it in the
   * user's language — and so the model cannot decide when to mention it. The
   * condition is computed here and the wording is fixed, which means it cannot
   * be omitted when it is true or invented when it is not.
   */
  arabicCoverageNoticeKey: string | null;
}

export interface MergeResult {
  sources: Source[];
  coverage: CoverageReport;
}

/** Below this many Arabic sources, the coverage gap is worth stating. */
const THIN_ARABIC_THRESHOLD = 2;

export function mergeSources(input: MergeInput): MergeResult {
  const seenDoi = new Map<string, Source>();
  const seenUrl = new Map<string, Source>();
  const unique: Source[] = [];
  let duplicatesRemoved = 0;

  for (const source of input.sources) {
    const doiKey = source.doi;
    const urlKey = normaliseUrl(source.url);

    const existing =
      (doiKey ? seenDoi.get(doiKey) : undefined) ?? (urlKey ? seenUrl.get(urlKey) : undefined);

    if (existing) {
      /*
       * A duplicate is a chance to improve the record rather than a thing to
       * discard. Crossref often has the better bibliographic metadata while
       * OpenAlex has the abstract and the open-access link; keeping the union
       * gives the researcher a fuller entry than either provider returned.
       */
      enrich(existing, source);
      duplicatesRemoved += 1;
      continue;
    }

    if (doiKey) seenDoi.set(doiKey, source);
    if (urlKey) seenUrl.set(urlKey, source);
    unique.push(source);
  }

  const ranked = unique.sort((a, b) => rank(b, input.preferredLanguage) - rank(a, input.preferredLanguage));
  const limited = input.limit ? ranked.slice(0, input.limit) : ranked;

  return { sources: limited, coverage: describeCoverage(limited, duplicatesRemoved, input.preferredLanguage) };
}

/* -------------------------------------------------------------------------- */
/*                                  Ranking                                   */
/* -------------------------------------------------------------------------- */

/**
 * A score built only from things that mean the same across providers.
 *
 * Provider relevance scores are deliberately excluded: they are on
 * incompatible scales and mixing them would let the provider with the larger
 * numbers dominate regardless of quality. What is used instead is a small set
 * of signals a researcher would themselves weigh.
 */
function rank(source: Source, preferred: SourceLanguage): number {
  let score = 0;

  /*
   * Language match is weighted heavily and on purpose. An Arabic thesis can
   * quote an Arabic source directly; an English one has to be translated, and
   * the translation is the researcher's responsibility and risk. Given two
   * comparable papers, the one in their language is more useful to them.
   */
  if (source.language === preferred) score += 40;

  /*
   * Citations as a rough quality signal, on a log scale. Linear would let one
   * famous paper bury everything else; the log says a 500-citation paper is
   * meaningfully better established than a 5-citation one without saying it is
   * a hundred times better.
   */
  if (typeof source.citationCount === 'number' && source.citationCount > 0) {
    score += Math.min(25, Math.log10(source.citationCount + 1) * 8);
  }

  /* Recency, mildly. Older work is often the better citation, so this is a nudge. */
  if (source.year) {
    const age = new Date().getFullYear() - source.year;
    if (age <= 5) score += 10;
    else if (age <= 10) score += 5;
  }

  /* A student can read an open-access paper today. That matters more than it looks. */
  if (source.openAccess) score += 8;

  /* An abstract lets the researcher judge relevance without opening the paper. */
  if (source.snippet) score += 6;

  /* A DOI is what makes a source citable and verifiable. */
  if (source.doi) score += 5;

  return score;
}

/**
 * Fills gaps in the kept record from the duplicate being discarded.
 *
 * Only fills — never overwrites. The first provider to return a source was
 * ranked first for a reason, and its version is treated as authoritative where
 * the two disagree.
 */
function enrich(kept: Source, duplicate: Source): void {
  if (!kept.snippet && duplicate.snippet) kept.snippet = duplicate.snippet;
  if (!kept.doi && duplicate.doi) kept.doi = duplicate.doi;
  if (!kept.container && duplicate.container) kept.container = duplicate.container;
  if (!kept.year && duplicate.year) kept.year = duplicate.year;
  if ((kept.authors?.length ?? 0) === 0 && duplicate.authors?.length) kept.authors = duplicate.authors;
  if (kept.citationCount === undefined && duplicate.citationCount !== undefined) {
    kept.citationCount = duplicate.citationCount;
  }
  /*
   * The open-access link is taken before the flag is copied, and the order is
   * the whole point.
   *
   * Copying the flag first sets `openAccess` to true on the kept record, after
   * which a check of the form "kept is not open access and the duplicate is"
   * can never fire — so the reader keeps a paywalled link to a paper that has a
   * free copy. A test caught this; reading the two statements in sequence did
   * not.
   */
  if (kept.openAccess !== true && duplicate.openAccess === true && duplicate.url) {
    kept.url = duplicate.url;
  }
  if (kept.openAccess !== true && duplicate.openAccess === true) {
    kept.openAccess = true;
  }
  if (kept.openAccess === undefined && duplicate.openAccess !== undefined) {
    kept.openAccess = duplicate.openAccess;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Coverage                                   */
/* -------------------------------------------------------------------------- */

function describeCoverage(
  sources: Source[],
  duplicatesRemoved: number,
  preferred: SourceLanguage,
): CoverageReport {
  const byLanguage = { ar: 0, en: 0, other: 0 };
  const byProvider: Record<string, number> = {};

  for (const source of sources) {
    if (source.language === 'ar') byLanguage.ar += 1;
    else if (source.language === 'en') byLanguage.en += 1;
    else byLanguage.other += 1;

    byProvider[source.provider] = (byProvider[source.provider] ?? 0) + 1;
  }

  /*
   * The notice fires only for an Arabic-speaking researcher, because only they
   * are affected by the gap. Two variants: nothing found at all, and too little
   * found to build on. Both name the reason — the indexes, not the literature —
   * so a researcher does not conclude that Arabic work on their topic does not
   * exist.
   */
  let arabicCoverageNoticeKey: string | null = null;

  if (preferred === 'ar' && sources.length > 0) {
    if (byLanguage.ar === 0) {
      arabicCoverageNoticeKey = 'knowledge.coverage.noArabicSources';
    } else if (byLanguage.ar < THIN_ARABIC_THRESHOLD) {
      arabicCoverageNoticeKey = 'knowledge.coverage.fewArabicSources';
    }
  }

  return {
    total: sources.length,
    byLanguage,
    byProvider,
    duplicatesRemoved,
    arabicCoverageNoticeKey,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Normalises a URL so two links to the same page compare equal.
 *
 * Tracking parameters, `www`, the scheme and a trailing slash all vary without
 * changing what the link points at.
 */
function normaliseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'fbclid') {
        url.searchParams.delete(key);
      }
    }
    const host = url.host.replace(/^www\./, '');
    const path = url.pathname.replace(/\/$/, '');
    return `${host}${path}${url.search}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase() || undefined;
  }
}
