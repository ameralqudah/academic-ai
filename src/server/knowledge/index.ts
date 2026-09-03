/**
 * Running a search across every provider that can answer it.
 *
 * The behaviour that matters is what happens when a provider fails, and the
 * rule is that nothing fails alone. OpenAlex's daily budget runs out, or
 * Semantic Scholar rate-limits, or a network call times out — and the search
 * still returns whatever the others found. A researcher gets a shorter list;
 * they do not get an error page.
 *
 * That is why `Promise.allSettled` rather than `Promise.all`, and why a
 * provider reports failure as a `SearchOutcome` with an `error` field rather
 * than by throwing. One vendor's outage is not the product's outage.
 *
 * Providers run in parallel because they are independent and each takes about a
 * second. Sequentially, a three-source academic search would take three
 * seconds; in parallel it takes as long as the slowest one.
 */

import { logger } from '@/lib/logger';

import { mergeSources, type CoverageReport } from './merge';
import { filterByRelevance, looksOffTopic } from './relevance';
import { CrossrefProvider } from './providers/crossref';
import { OpenAlexProvider } from './providers/openalex';
import type { KnowledgeProvider, SearchQuery, Source, SourceKind, SourceLanguage } from './types';

export interface SearchRequest {
  /** The query, or two of them when searching bilingually. */
  queries: SearchQuery[];
  kind?: SourceKind;
  /** The researcher's language — sources in it rank higher. */
  preferredLanguage: SourceLanguage;
  limit?: number;
}

export interface SearchReport {
  sources: Source[];
  coverage: CoverageReport;
  /**
   * True when the results do not appear to concern the query.
   *
   * Reported rather than acted on: ten papers on the wrong subject are more
   * useful than zero, and the caller decides whether to warn, re-search, or
   * ask the researcher to rephrase.
   */
  offTopic: boolean;
  /** Results removed as irrelevant, so a narrow search can say it was narrow. */
  discardedAsIrrelevant: number;
  /** Per provider, so a coverage gap can be told apart from an outage. */
  providers: {
    name: string;
    returned: number;
    totalAvailable: number | null;
    tookMs: number;
    error?: string;
  }[];
  queriesRun: { text: string; language: SourceLanguage }[];
  tookMs: number;
}

/**
 * The providers, in the order they are preferred when results tie.
 *
 * Crossref first because it needs no key and cannot be switched off by a
 * vendor's pricing decision. OpenAlex second: it adds real coverage — more
 * non-English work, abstracts, citation counts — but it is metered, and a
 * metered source must never be the one the product depends on.
 */
function academicProviders(): KnowledgeProvider[] {
  return [new CrossrefProvider(), new OpenAlexProvider()];
}

export async function search(request: SearchRequest): Promise<SearchReport> {
  const startedAt = Date.now();

  const providers = academicProviders().filter((provider) => {
    if (!provider.isConfigured()) return false;
    if (request.kind && !provider.kinds.includes(request.kind)) return false;
    return true;
  });

  if (providers.length === 0) {
    return {
      sources: [],
      coverage: {
        total: 0,
        byLanguage: { ar: 0, en: 0, other: 0 },
        byProvider: {},
        duplicatesRemoved: 0,
        arabicCoverageNoticeKey: null,
      },
      providers: [],
      /* No providers ran, so there is nothing to judge relevance against. */
      offTopic: false,
      discardedAsIrrelevant: 0,
      queriesRun: request.queries.map((query) => ({ text: query.text, language: query.language })),
      tookMs: Date.now() - startedAt,
    };
  }

  /*
   * Every provider × every query, all at once. Two queries across two providers
   * is four calls that together take about as long as one.
   */
  const calls = providers.flatMap((provider) =>
    request.queries.map((query) => ({ provider, query })),
  );

  const settled = await Promise.allSettled(
    calls.map(({ provider, query }) =>
      provider.search({ ...query, limit: request.limit ?? 10, kind: request.kind }),
    ),
  );

  const collected: Source[] = [];
  const reports: SearchReport['providers'] = [];

  for (let index = 0; index < settled.length; index += 1) {
    const call = calls[index] as { provider: KnowledgeProvider; query: SearchQuery };
    const result = settled[index] as PromiseSettledResult<Awaited<ReturnType<KnowledgeProvider['search']>>>;

    if (result.status === 'rejected') {
      /*
       * A provider that throws rather than returning an error outcome is a bug
       * in that provider — logged as such, and then treated exactly like any
       * other failure so the search continues.
       */
      logger.warn('knowledge.provider.threw', {
        provider: call.provider.name,
        error: String(result.reason),
      });
      reports.push({
        name: call.provider.name,
        returned: 0,
        totalAvailable: null,
        tookMs: 0,
        error: 'threw',
      });
      continue;
    }

    const outcome = result.value;
    collected.push(...outcome.sources);

    if (outcome.error) {
      /*
       * Logged with the provider's own explanation attached. A failure that
       * reports only a reason key is a failure nobody can diagnose without
       * reproducing it — which is exactly what happened when every Crossref
       * search returned "providerFailed" and nothing else.
       */
      logger.warn('knowledge.provider.failed', {
        provider: outcome.provider,
        reason: outcome.error.reasonKey,
        detail: outcome.error.detail,
        query: call.query.text.slice(0, 80),
      });
    }

    reports.push({
      name: outcome.provider,
      returned: outcome.sources.length,
      totalAvailable: outcome.totalAvailable,
      tookMs: outcome.tookMs,
      ...(outcome.error ? { error: outcome.error.detail ?? outcome.error.reasonKey } : {}),
    });
  }

  const merged = mergeSources({
    sources: collected,
    preferredLanguage: request.preferredLanguage,
    limit: request.limit ?? 10,
  });

  /*
   * Relevance checked after retrieval, against the text we actually received.
   *
   * A researcher asked for studies on hybrid learning and received ten papers
   * about learning disabilities: Crossref's Arabic index is shallow, and a
   * two-word phrase matches anything containing the commoner word. The provider
   * cannot tell the difference; this can, because it has the titles.
   *
   * Only the first query is used for filtering — a multi-query search is
   * deliberately broad, and narrowing it to one of its queries would discard
   * what the others found.
   */
  const primaryQuery = request.queries[0]?.text ?? '';
  const relevance = primaryQuery ? filterByRelevance(merged.sources, primaryQuery) : null;
  const offTopic = primaryQuery ? looksOffTopic(merged.sources, primaryQuery) : false;

  if (relevance && relevance.discarded > 0) {
    logger.info('knowledge.filtered', {
      query: primaryQuery.slice(0, 80),
      kept: relevance.kept.length,
      discarded: relevance.discarded,
    });
  }

  if (offTopic) {
    /*
     * Logged, and reported to the caller rather than hidden. A search whose
     * distinctive term appears in none of the results found the wrong corpus,
     * and the researcher should be told that instead of being handed ten papers
     * on another subject as though they answered the question.
     */
    logger.warn('knowledge.offTopic', {
      query: primaryQuery.slice(0, 80),
      returned: merged.sources.length,
    });
  }

  logger.info('knowledge.search', {
    queries: request.queries.length,
    providers: providers.length,
    collected: collected.length,
    afterMerge: merged.sources.length,
    arabicSources: merged.coverage.byLanguage.ar,
    ms: Date.now() - startedAt,
  });

  return {
    sources: relevance?.kept ?? merged.sources,
    coverage: merged.coverage,
    /*
     * True when the results do not appear to concern the query. The caller
     * warns the researcher rather than presenting them as an answer.
     */
    offTopic,
    discardedAsIrrelevant: relevance?.discarded ?? 0,
    providers: reports,
    queriesRun: request.queries.map((query) => ({ text: query.text, language: query.language })),
    tookMs: Date.now() - startedAt,
  };
}

export { lookupByDoi } from './providers/crossref';
export { mergeSources } from './merge';
export { CrossrefProvider } from './providers/crossref';
export { OpenAlexProvider } from './providers/openalex';
export * from './types';
export type { CoverageReport } from './merge';
