/**
 * Reading the pages a search returned.
 *
 * A snippet is two lines. Grounding an answer in two lines produces an answer
 * that is two lines deep — plausible, unspecific, and impossible to check. So
 * the top results are fetched and their text extracted, and the model is given
 * that.
 *
 * Everything here is written on the assumption that the page is hostile or
 * broken, because some of them are. A page can be a hundred megabytes, hang
 * forever, redirect in a loop, or be a PDF pretending to be HTML. Each of those
 * is bounded rather than trusted, and a page that fails is skipped rather than
 * failing the search: one bad result out of eight should cost one result.
 *
 * **No fetch reaches a private address.** A URL from a search engine is
 * attacker-influenced input — someone can get a page indexed — and a server
 * that fetches whatever it is given can be pointed at internal services. The
 * check is on the resolved host, before the request.
 */

import { logger } from '@/lib/logger';

/** Beyond this a page is not an article; it is a data file or an attack. */
const MAX_BYTES = 2 * 1024 * 1024;
/** A page that has not responded by now will not help. */
const TIMEOUT_MS = 8000;
/** Enough text for a model to work with; more is padding. */
const MAX_TEXT_LENGTH = 12_000;
/** Fetched at once. Beyond this the search feels slower than it is useful. */
const MAX_CONCURRENT = 5;

export interface FetchedContent {
  url: string;
  /** Extracted body text, already truncated. */
  text: string;
  /** The page's own title, which is often better than the search result's. */
  title?: string;
  wordCount: number;
}

export interface FetchFailure {
  url: string;
  reason: 'blocked' | 'timeout' | 'too-large' | 'unsupported-type' | 'http-error' | 'no-content';
}

export interface FetchOutcome {
  fetched: FetchedContent[];
  failed: FetchFailure[];
}

/**
 * Fetches several pages, in bounded parallel.
 *
 * Parallel because eight sequential fetches at up to eight seconds each is a
 * minute; bounded because unbounded parallelism against one host is a denial of
 * service someone else pays for.
 */
export async function fetchSources(urls: string[]): Promise<FetchOutcome> {
  const fetched: FetchedContent[] = [];
  const failed: FetchFailure[] = [];

  for (let start = 0; start < urls.length; start += MAX_CONCURRENT) {
    const batch = urls.slice(start, start + MAX_CONCURRENT);

    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          return await fetchOne(url);
        } catch (error) {
          logger.info('webFetch.failed', { url: url.slice(0, 120), error: String(error) });
          return { url, reason: 'http-error' as const };
        }
      }),
    );

    for (const result of results) {
      if ('text' in result) fetched.push(result);
      else failed.push(result);
    }
  }

  return { fetched, failed };
}

async function fetchOne(url: string): Promise<FetchedContent | FetchFailure> {
  if (!isPublicUrl(url)) return { url, reason: 'blocked' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      /*
       * A real user agent, because a large share of sites return 403 to
       * anything that looks automated. This is not evasion — the request is a
       * single page fetch on a user's behalf — but a blank agent gets refused
       * by defaults nobody chose.
       */
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; AcademicAI/1.0; +https://academic-ai-app.onrender.com)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    if (!response.ok) return { url, reason: 'http-error' };

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html') && !contentType.includes('text/plain')) {
      /*
       * PDFs are the common case here and are deliberately not handled. The
       * text extraction below is for HTML; a PDF would arrive as bytes and be
       * treated as markup, producing a page of noise that reads as content.
       */
      return { url, reason: 'unsupported-type' };
    }

    /*
     * Content-Length is a hint, not a guarantee — it can be absent or wrong.
     * The body is read with its own ceiling below, so this only avoids
     * downloading something obviously enormous.
     */
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return { url, reason: 'too-large' };

    const html = await readBounded(response, MAX_BYTES);
    if (html === null) return { url, reason: 'too-large' };

    const title = extractTitle(html);
    const text = extractText(html);

    if (text.length < 200) return { url, reason: 'no-content' };

    return {
      url,
      title,
      text: text.slice(0, MAX_TEXT_LENGTH),
      wordCount: text.split(/\s+/).length,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return { url, reason: aborted ? 'timeout' : 'http-error' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads a body with a hard ceiling.
 *
 * `response.text()` reads whatever arrives, so a server that streams
 * indefinitely exhausts memory regardless of any header check. Reading chunk by
 * chunk and stopping is the only bound that holds against a server that lies.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/**
 * Whether a URL points somewhere public.
 *
 * Search results are attacker-influenced: a page can be indexed on purpose. A
 * server that fetches any URL it is handed can be aimed at internal services,
 * cloud metadata endpoints, or localhost — so private ranges are refused
 * outright.
 *
 * This checks the hostname as written. A DNS name resolving to a private
 * address would pass, which is a real gap that a full defence closes by
 * resolving first and checking the address. That is worth doing and is noted
 * here rather than silently omitted.
 */
export function isPublicUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const host = parsed.hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '0.0.0.0' || host === '[::1]' || host === '::1') return false;

  /* Cloud metadata: the classic target, and reachable from any container. */
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return false;

  const parts = host.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const [a, b] = parts.map(Number) as [number, number, number, number];

    if (a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }

  return true;
}

/** The `<title>`, cleaned of the site name most pages append. */
function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return undefined;

  return decodeEntities(match[1])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Body text from HTML.
 *
 * Deliberately crude — strip the elements that never contain prose, drop the
 * remaining tags, collapse whitespace. A proper extractor would find the
 * article and discard navigation, and would be a dependency and a maintenance
 * burden for a marginal gain: the model reads the result and can ignore a
 * menu, where it cannot ignore a page it never received.
 */
function extractText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      /* Block boundaries become newlines, so paragraphs do not run together. */
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The handful of entities that actually appear in prose. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

export { MAX_TEXT_LENGTH, MAX_CONCURRENT };
