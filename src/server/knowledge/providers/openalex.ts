/**
 * OpenAlex — a second academic source, better with a key and working without one.
 *
 * The design constraint here is a requirement rather than a preference: **a
 * missing key must never stop the application.** OpenAlex changed its terms in
 * February 2026 — keys became mandatory and usage became metered — and a
 * provider written to assume a key would have turned a free enhancement into a
 * hard dependency on a vendor decision.
 *
 * So this provider degrades in three steps rather than failing:
 *
 * 1. **With a key** — roughly a thousand searches a day within the free
 *    allowance, which is more than this product will use.
 * 2. **Without a key** — a tenth of that. Enough for light traffic, and the
 *    application does not know the difference until the budget runs out.
 * 3. **Budget exhausted, or the service down** — the search returns an error
 *    outcome, Crossref's results still arrive, and the user gets an answer.
 *
 * The value it adds over Crossref is real: broader coverage of non-English and
 * Global South scholarship, plus abstracts and citation counts that Crossref
 * often lacks. That is worth having as long as it never becomes load-bearing.
 *
 * One quirk worth knowing about, and worked around below: OpenAlex stores
 * abstracts as an *inverted index* — a map of each word to the positions where
 * it occurs — rather than as text.
 */

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

import {
  cleanAbstract,
  detectLanguage,
  normaliseDoi,
  type KnowledgeProvider,
  type SearchOutcome,
  type SearchQuery,
  type Source,
} from '../types';

const BASE = 'https://api.openalex.org/works';
const TIMEOUT_MS = 8000;

/** Transcribed from a live response rather than from the documentation. */
interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number;
  publication_date?: string;
  language?: string;
  cited_by_count?: number;
  relevance_score?: number;
  abstract_inverted_index?: Record<string, number[]>;
  open_access?: { is_oa?: boolean; oa_url?: string | null };
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
    source?: { display_name?: string | null } | null;
  } | null;
  authorships?: { author?: { display_name?: string | null } | null }[];
}

interface OpenAlexResponse {
  meta?: { count?: number; cost_usd?: number };
  results?: OpenAlexWork[];
}

export class OpenAlexProvider implements KnowledgeProvider {
  readonly name = 'openalex';
  readonly kinds = ['academic'] as const;

  /*
   * Configuration is read when a search runs, not when the provider is built.
   *
   * `getEnv()` validates the whole environment — including the database URL and
   * the auth secret — and throws if anything is missing. Calling it from a
   * constructor made merely *creating* a search provider depend on a configured
   * database, which is both wrong and surprising: it broke the test suite, and
   * it is why the production build failed in an environment that had no
   * database credentials.
   *
   * A search provider has no business requiring a database to exist.
   */
  private config(): { apiKey?: string; contact?: string } {
    try {
      const env = getEnv();
      return { apiKey: env.OPENALEX_API_KEY, contact: env.EMAIL_FROM };
    } catch {
      // An unconfigured environment means no key and no contact — which is a
      // working state for this provider, not a failure.
      return {};
    }
  }

  /**
   * Always true, deliberately.
   *
   * Returning false without a key would remove OpenAlex from the router
   * entirely, which is a worse outcome than using the smaller free allowance.
   * The key raises the ceiling; it is not an entry requirement.
   */
  isConfigured(): boolean {
    return true;
  }

  hasKey(): boolean {
    return Boolean(this.config().apiKey);
  }

  async search(query: SearchQuery): Promise<SearchOutcome> {
    const startedAt = Date.now();

    const url = new URL(BASE);
    url.searchParams.set('search', query.text);
    url.searchParams.set('per_page', String(Math.min(query.limit ?? 10, 50)));

    if (query.fromYear) {
      url.searchParams.set('filter', `from_publication_date:${query.fromYear}-01-01`);
    }

    const { apiKey, contact } = this.config();

    if (apiKey) url.searchParams.set('api_key', apiKey);
    // The "polite pool" — faster and more reliable, and it costs an email address.
    else if (contact) url.searchParams.set('mailto', contact);

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        /*
         * 429 means the daily budget is spent — expected on the keyless tier
         * and not a fault. Logged at info so it is visible as a signal to add a
         * key, rather than as an error that suggests something is broken.
         */
        if (response.status === 429) {
          logger.info('knowledge.openalex.budgetExhausted', { hasKey: this.hasKey() });
          return this.failure(startedAt, 'knowledge.error.budgetExhausted', 'HTTP 429');
        }
        return this.failure(startedAt, 'knowledge.error.providerFailed', `HTTP ${response.status}`);
      }

      const data = (await response.json()) as OpenAlexResponse;

      /*
       * OpenAlex now reports what each call cost. Recorded so the spend is
       * observable before it becomes a surprise — the same reason the agent
       * measures tasks it does not yet charge for.
       */
      if (typeof data.meta?.cost_usd === 'number' && data.meta.cost_usd > 0) {
        logger.info('knowledge.openalex.cost', {
          costUsd: data.meta.cost_usd,
          hasKey: this.hasKey(),
        });
      }

      return {
        sources: (data.results ?? [])
          .map((work) => this.toSource(work))
          .filter((source): source is Source => source !== null),
        totalAvailable: data.meta?.count ?? null,
        provider: this.name,
        tookMs: Date.now() - startedAt,
      };
    } catch (error) {
      return this.failure(
        startedAt,
        error instanceof Error && error.name === 'TimeoutError'
          ? 'knowledge.error.timeout'
          : 'knowledge.error.providerFailed',
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }

  private toSource(work: OpenAlexWork): Source | null {
    const title = (work.title ?? work.display_name ?? '').trim();
    if (!title) return null;

    const doi = normaliseDoi(work.doi);
    const openAccessUrl = work.open_access?.oa_url;
    const landing = work.primary_location?.landing_page_url;

    return {
      kind: 'academic',
      title,
      /*
       * Preference order matters to a student: the open-access copy first,
       * because it is the one they can actually read, then the publisher page,
       * then the DOI.
       */
      url: openAccessUrl ?? landing ?? (doi ? `https://doi.org/${doi}` : ''),
      doi,
      snippet: cleanAbstract(rebuildAbstract(work.abstract_inverted_index)),
      authors: (work.authorships ?? [])
        .map((authorship) => authorship.author?.display_name?.trim())
        .filter((name): name is string => Boolean(name))
        .slice(0, 10),
      container: work.primary_location?.source?.display_name?.trim() ?? undefined,
      year: work.publication_year,
      publishedAt: work.publication_date,
      /*
       * Detected from the title rather than read from `work.language`. A
       * published assessment of OpenAlex found its language metadata
       * over-reports English and under-reports everything else — which would
       * make Arabic sources invisible in exactly the place it matters most.
       */
      language: detectLanguage(title),
      citationCount: work.cited_by_count,
      openAccess: work.open_access?.is_oa,
      provider: this.name,
      score: work.relevance_score,
      retrievedAt: new Date().toISOString(),
    };
  }

  private failure(startedAt: number, reasonKey: string, detail: string): SearchOutcome {
    return {
      sources: [],
      totalAvailable: null,
      provider: this.name,
      error: { reasonKey, detail },
      tookMs: Date.now() - startedAt,
    };
  }
}

/**
 * Reconstructs an abstract from OpenAlex's inverted index.
 *
 * The field is a map of word to the positions where it appears —
 * `{"cooperative": [0, 14], "learning": [1]}` — which is a sensible format for
 * a search engine and useless as prose. Rebuilding it means placing each word
 * at each of its positions and reading the array back in order.
 *
 * Capped at 400 words: an abstract longer than that is a data error, and
 * allocating an array sized by an untrusted number is how a malformed response
 * becomes an outage.
 */
function rebuildAbstract(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;

  const words: (string | undefined)[] = [];
  let highest = 0;

  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (typeof position !== 'number' || position < 0 || position > 400) continue;
      words[position] = word;
      if (position > highest) highest = position;
    }
  }

  if (highest === 0) return undefined;

  const text = words
    .slice(0, highest + 1)
    .filter((word): word is string => typeof word === 'string')
    .join(' ');

  return text.length > 0 ? text : undefined;
}
