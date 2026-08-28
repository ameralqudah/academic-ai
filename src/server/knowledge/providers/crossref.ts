/**
 * Crossref — the primary academic source.
 *
 * Chosen as primary for one reason that outweighs the rest: **it needs no key
 * and charges nothing.** OpenAlex began requiring an API key in February 2026
 * and now meters usage; Semantic Scholar rejected our very first unauthenticated
 * request with a 429. Crossref answered immediately and asked for nothing.
 *
 * A product whose academic search stops working the day a key expires is a
 * product whose academic search will stop working. So the base capability rests
 * on the source that cannot be switched off, and the metered ones are
 * enhancements layered above it.
 *
 * The response shape here was read from a live call rather than from
 * documentation, which caught something the docs would not have: **the title is
 * an array, not a string.** So is `container-title`. Building against the
 * documented shape would have produced a provider that returned `undefined` for
 * every title and looked, from the outside, like a coverage problem.
 *
 * Crossref asks API users to identify themselves in the User-Agent with a
 * contact address, in exchange for the faster "polite pool". Doing so is both
 * good manners and materially faster.
 */

import { getEnv } from '@/config/env';

import {
  cleanAbstract,
  detectLanguage,
  normaliseDoi,
  type KnowledgeProvider,
  type SearchOutcome,
  type SearchQuery,
  type Source,
} from '../types';

const BASE = 'https://api.crossref.org/works';
const TIMEOUT_MS = 8000;

/**
 * The contact address for Crossref's polite pool.
 *
 * Reads the environment defensively: `getEnv()` validates everything at once
 * and throws when the database credentials are missing, and an academic search
 * has no reason to care whether a database is configured.
 */
function contactAddress(): string {
  try {
    return getEnv().EMAIL_FROM ?? 'support@academic-ai.app';
  } catch {
    return 'support@academic-ai.app';
  }
}

/** The shape Crossref actually returns, transcribed from a live response. */
interface CrossrefItem {
  DOI?: string;
  /** An array. Almost always one element, occasionally more, sometimes empty. */
  title?: string[];
  'container-title'?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  abstract?: string;
  URL?: string;
  publisher?: string;
  type?: string;
  score?: number;
  'is-referenced-by-count'?: number;
  language?: string;
  issued?: { 'date-parts'?: number[][] };
  published?: { 'date-parts'?: number[][] };
  'published-print'?: { 'date-parts'?: number[][] };
}

interface CrossrefResponse {
  status?: string;
  message?: {
    'total-results'?: number;
    items?: CrossrefItem[];
  };
}

export class CrossrefProvider implements KnowledgeProvider {
  readonly name = 'crossref';
  readonly kinds = ['academic'] as const;

  /** Always usable. That is the point of making it primary. */
  isConfigured(): boolean {
    return true;
  }

  private userAgent(): string {
    /*
     * Crossref's polite pool is faster and more reliable, and joining it costs
     * only an honest User-Agent with a contact address. The address falls back
     * to a generic one rather than being omitted — a missing contact drops the
     * request into the anonymous pool.
     *
     * Wrapped because `getEnv()` validates the entire environment and throws
     * when the database URL is absent. A search provider must not require a
     * database to exist: that coupling broke the test suite and the production
     * build before it was caught.
     */
    return `AcademicAI/1.0 (https://academic-ai-app.onrender.com; mailto:${contactAddress()})`;
  }

  async search(query: SearchQuery): Promise<SearchOutcome> {
    const startedAt = Date.now();

    const url = new URL(BASE);
    url.searchParams.set('query', query.text);
    url.searchParams.set('rows', String(Math.min(query.limit ?? 10, 50)));
    /*
     * Sorted by relevance explicitly. Crossref's default ordering is by score
     * already, but stating it means a change in their default does not silently
     * change what a researcher sees.
     */
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('select',
      'DOI,title,container-title,author,abstract,URL,publisher,type,score,is-referenced-by-count,language,issued,published');

    if (query.fromYear) {
      url.searchParams.set('filter', `from-pub-date:${query.fromYear}-01-01`);
    }

    try {
      const response = await fetch(url, {
        headers: { 'user-agent': this.userAgent(), accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!response.ok) {
        return this.failure(startedAt, 'knowledge.error.providerFailed', `HTTP ${response.status}`);
      }

      const data = (await response.json()) as CrossrefResponse;
      const items = data.message?.items ?? [];

      return {
        sources: items.map((item) => this.toSource(item)).filter((source): source is Source => source !== null),
        totalAvailable: data.message?.['total-results'] ?? null,
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

  private toSource(item: CrossrefItem): Source | null {
    const title = item.title?.[0]?.trim();

    /*
     * Crossref indexes things that are not papers — datasets, components,
     * corrections — and some carry no title at all. A source with no title is
     * not something a researcher can cite, so it is dropped rather than shown
     * as "(untitled)".
     */
    if (!title) return null;

    const doi = normaliseDoi(item.DOI);

    /*
     * Language from the title's script rather than from the `language` field.
     * That field is frequently absent and, when present, frequently wrong — an
     * Arabic-titled article deposited by a publisher whose default is "en".
     * The script does not lie.
     */
    const language = detectLanguage(title);

    return {
      kind: 'academic',
      title,
      url: item.URL ?? (doi ? `https://doi.org/${doi}` : ''),
      doi,
      snippet: cleanAbstract(item.abstract),
      authors: (item.author ?? [])
        .map((author) =>
          author.name?.trim() ?? [author.given, author.family].filter(Boolean).join(' ').trim(),
        )
        .filter((name) => name.length > 0)
        .slice(0, 10),
      container: item['container-title']?.[0]?.trim() ?? item.publisher?.trim(),
      year: yearOf(item),
      language,
      citationCount: item['is-referenced-by-count'],
      provider: this.name,
      score: item.score,
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
 * The publication year, from whichever date field is present.
 *
 * Crossref carries several and they disagree: `issued` is when the work was
 * published in any form, `published-print` when it reached print. `issued` is
 * checked first because it is the one a citation uses.
 */
function yearOf(item: CrossrefItem): number | undefined {
  const candidates = [item.issued, item.published, item['published-print']];

  for (const candidate of candidates) {
    const year = candidate?.['date-parts']?.[0]?.[0];
    if (typeof year === 'number' && year > 1500 && year <= new Date().getFullYear() + 1) {
      return year;
    }
  }

  return undefined;
}

/**
 * Looks up one work by its DOI — for verifying a reference a researcher pasted.
 *
 * A separate method because it answers a different question. Search asks "what
 * exists about this topic"; this asks "is this specific reference real, and
 * does it say what the citation claims". The second is what turns an unverified
 * bibliography into a checked one.
 */
export async function lookupByDoi(doi: string): Promise<Source | null> {
  const normalised = normaliseDoi(doi);
  if (!normalised) return null;

  const provider = new CrossrefProvider();

  try {
    const response = await fetch(`${BASE}/${encodeURIComponent(normalised)}`, {
      headers: {
        'user-agent': `AcademicAI/1.0 (mailto:${contactAddress()})`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { message?: CrossrefItem };
    if (!data.message) return null;

    // Reuse the same mapping, so a looked-up source and a searched one are identical.
    return (provider as unknown as { toSource(item: CrossrefItem): Source | null }).toSource(data.message);
  } catch {
    return null;
  }
}
