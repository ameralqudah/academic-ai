/**
 * Deduplication, kept apart from the pipeline that uses it.
 *
 * This is arithmetic on URLs and DOIs — no network, no model, no database. It
 * lives in its own module because importing the pipeline pulls in the AI
 * service and through it the database, and a test that wants to check URL
 * normalisation should not need a database to do it.
 *
 * That coupling has now appeared five times in this codebase: the knowledge
 * providers, the production build, model discovery, the mode catalogue, and
 * here. The pattern is always the same — a module that needs one small pure
 * function imports the module that happens to contain it, and drags everything
 * behind it. Separating the pure part is the fix each time.
 */

import type { Source } from '@/server/knowledge/types';

/**
 * Removes the same source arriving from several sub-questions.
 *
 * By DOI where there is one, by normalised URL otherwise. Five sub-questions on
 * one topic return heavily overlapping results, and without this the report
 * cites the same paper as [3], [11] and [17] — which reads as three studies
 * agreeing with each other.
 */
export function deduplicate(sources: Source[]): { unique: Source[]; removed: number } {
  const seen = new Map<string, Source>();
  let removed = 0;

  for (const source of sources) {
    const key = source.doi ? `doi:${source.doi.toLowerCase()}` : `url:${normaliseUrl(source.url)}`;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, source);
      continue;
    }

    removed += 1;

    /*
     * The richer record wins. The same paper from Crossref and OpenAlex may
     * carry an abstract in one and a citation count in the other, and keeping
     * whichever arrived first would discard information for no reason.
     */
    if (!existing.snippet && source.snippet) {
      seen.set(key, { ...existing, snippet: source.snippet });
    } else if ((source.citationCount ?? 0) > (existing.citationCount ?? 0)) {
      seen.set(key, { ...existing, citationCount: source.citationCount });
    }
  }

  return { unique: [...seen.values()], removed };
}

export function sameSource(
  a: { doi?: string; url: string },
  b: { doi?: string; url: string },
): boolean {
  if (a.doi && b.doi) return a.doi.toLowerCase() === b.doi.toLowerCase();
  return normaliseUrl(a.url) === normaliseUrl(b.url);
}

/**
 * Strips the parts of a URL that do not change what it points at.
 *
 * `www`, a trailing slash and campaign parameters make one page look like
 * several. A real query parameter is kept, because `?q=term` is a different
 * page from `?q=other`.
 */
export function normaliseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';

    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'ref' || key === 'fbclid') {
        parsed.searchParams.delete(key);
      }
    }

    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/$/, '');

    return `${host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
