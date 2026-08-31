/**
 * Web search, through Serper.
 *
 * Built to the same `KnowledgeProvider` contract as Crossref and OpenAlex, so
 * the merging, deduplication and failure isolation that already exist apply to
 * web results without a second implementation. A web page and a journal article
 * are different things, but "a source the researcher can read, with a title, a
 * URL and a snippet" is the same shape, and the shape is what the contract
 * describes.
 *
 * **Serper is a wrapper over Google.** That is its value — the result quality is
 * Google's — and its constraint: results are what a search engine returns, not
 * a curated academic index. Anything from here is presented as a web source and
 * never as a citable reference, which is a distinction the interface has to
 * carry through.
 *
 * **The key never leaves the server.** This module is imported only by server
 * code; the client asks the API route, which asks this. Putting the key in a
 * client bundle would publish it to anyone who opens the network tab.
 */

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

import {
  detectLanguage,
  type KnowledgeProvider,
  type SearchOutcome,
  type SearchQuery,
  type Source,
  type SourceKind,
} from '../types';

/** Serper's own ceiling per request; asking for more is silently truncated. */
const MAX_RESULTS = 20;
/** A search that has not answered in this long will not answer usefully. */
const TIMEOUT_MS = 12_000;

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  position?: number;
  sitelinks?: unknown;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
  answerBox?: { title?: string; link?: string; snippet?: string; answer?: string };
  knowledgeGraph?: { title?: string; descriptionLink?: string; description?: string };
  credits?: number;
}

export class SerperProvider implements KnowledgeProvider {
  readonly name = 'serper';
  readonly kinds: readonly SourceKind[] = ['web', 'news'];

  /**
   * Whether a key is configured.
   *
   * Read lazily rather than in a constructor. `getEnv()` validates the whole
   * environment and throws when the database URL is missing — which has nothing
   * to do with web search, and which broke the knowledge providers and the
   * production build before it was caught there. Reading it inside a try means
   * an unconfigured environment produces "not available" rather than a crash.
   */
  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  private apiKey(): string | undefined {
    try {
      return getEnv().SERPER_API_KEY;
    } catch {
      return undefined;
    }
  }

  async search(query: SearchQuery): Promise<SearchOutcome> {
    const startedAt = Date.now();
    const key = this.apiKey();

    if (!key) {
      /*
       * Not configured is a normal outcome, not an error. The merge layer
       * treats a provider that returns nothing the same whether it is missing a
       * key or genuinely found nothing — which is what lets academic search
       * keep working while web search is unconfigured.
       */
      return {
        sources: [],
        totalAvailable: null,
        provider: this.name,
        tookMs: 0,
        error: { reasonKey: 'knowledge.error.notConfigured' },
      };
    }

    const limit = Math.min(query.limit ?? 10, MAX_RESULTS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'X-API-KEY': key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          q: query.text,
          num: limit,
          /*
           * The interface language follows the query's language rather than the
           * user's. Someone researching in Arabic wants Arabic-language results
           * even if their interface is in English, and someone searching an
           * English technical term wants English results whatever their
           * interface says.
           */
          ...(query.language === 'ar' ? { hl: 'ar', gl: 'jo' } : { hl: 'en' }),
        }),
      });

      if (!response.ok) {
        /*
         * The body is logged, not just the status. A 400 from a search API
         * usually says which parameter it disliked, and discarding that turns a
         * five-minute fix into an afternoon — which is exactly what happened
         * with Crossref's `select` parameter.
         */
        const body = await response.text().catch(() => '');

        logger.error('serper.searchFailed', {
          status: response.status,
          body: body.slice(0, 400),
        });

        return {
          sources: [],
          totalAvailable: null,
          provider: this.name,
          tookMs: Date.now() - startedAt,
          error: {
            reasonKey:
              response.status === 429
                ? 'knowledge.error.rateLimited'
                : response.status === 401 || response.status === 403
                  ? 'knowledge.error.unauthorised'
                  : 'knowledge.error.providerFailed',
            detail: `HTTP ${response.status}`,
          },
        };
      }

      const payload = (await response.json()) as SerperResponse;
      const sources = this.toSources(payload, query);

      logger.info('serper.searched', {
        query: query.text.slice(0, 80),
        returned: sources.length,
        credits: payload.credits,
      });

      return {
        sources,
        totalAvailable: null,
        provider: this.name,
        tookMs: Date.now() - startedAt,
      };
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';

      logger.error('serper.searchError', {
        error: String(error),
        timedOut: aborted,
      });

      return {
        sources: [],
        totalAvailable: null,
        provider: this.name,
        tookMs: Date.now() - startedAt,
        error: {
          reasonKey: aborted ? 'knowledge.error.timeout' : 'knowledge.error.providerFailed',
          detail: String(error).slice(0, 200),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Turns Serper's payload into sources.
   *
   * The answer box and knowledge graph are deliberately ignored. They are
   * Google's own summary rather than a source anyone can cite, and including
   * them would put an unattributable claim into a set the researcher is being
   * invited to treat as evidence.
   */
  private toSources(payload: SerperResponse, query: SearchQuery): Source[] {
    const retrievedAt = new Date().toISOString();

    return (payload.organic ?? [])
      .filter((result): result is SerperOrganicResult & { title: string; link: string } =>
        Boolean(result.title && result.link),
      )
      .map((result) => ({
        kind: 'web' as const,
        title: result.title.trim(),
        url: result.link,
        snippet: result.snippet?.trim(),
        container: hostOf(result.link),
        /*
         * Language detected from the text rather than taken from the request.
         * Asking for Arabic results does not guarantee Arabic results, and a
         * source labelled by what was requested rather than what arrived would
         * mislead the coverage report.
         */
        language: detectLanguage(`${result.title} ${result.snippet ?? ''}`),
        publishedAt: result.date,
        year: yearFrom(result.date),
        provider: this.name,
        /*
         * Position inverted into a score, so ranking is comparable in direction
         * with the other providers — higher is better everywhere. The scale is
         * still not comparable across providers, which the contract says.
         */
        score: result.position ? 1 / result.position : undefined,
        retrievedAt,
      }))
      .filter((source) => source.title.length > 0 && isUsableUrl(source.url, query));
  }
}

/**
 * Whether a URL is worth returning.
 *
 * Filters the results that are technically pages and practically useless: file
 * downloads a researcher cannot read in a browser, and the search engine's own
 * property pages.
 */
function isUsableUrl(url: string, _query: SearchQuery): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    /* Aggregators that return a redirect rather than content. */
    const blocked = ['google.com', 'googleusercontent.com', 'webcache.googleusercontent.com'];
    if (blocked.some((host) => parsed.hostname.endsWith(host))) return false;

    return true;
  } catch {
    return false;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** A four-digit year from Serper's free-form date string, when there is one. */
function yearFrom(date?: string): number | undefined {
  if (!date) return undefined;
  const match = date.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}
