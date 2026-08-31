/**
 * Answering from the web.
 *
 * Search, then read, then answer — and the middle step is what makes the
 * difference. An answer written from search snippets is two lines deep and
 * cannot be checked; an answer written from the pages themselves can cite a
 * specific claim to a specific source.
 *
 * **The model is given a closed set and told it may use nothing else.** This is
 * the same discipline the literature search uses, and for the same reason:
 * asked about a topic, a model will add a fact it half-remembers, and the fact
 * will read correctly and be unattributable. Every sentence here has to trace
 * to a numbered source or not be written.
 *
 * **Web sources are not citable references, and the answer says so.** A blog
 * post and a peer-reviewed article are both "sources" to a search engine and
 * are not the same thing to a thesis committee. The distinction is carried into
 * the answer rather than left for the student to notice.
 */

import { logger } from '@/lib/logger';
import { fetchSources } from '@/server/knowledge/fetch-content';
import { SerperProvider } from '@/server/knowledge/providers/serper';
import type { Source } from '@/server/knowledge/types';
import { AppError } from '@/server/http/errors';
import { answerFromSources } from '@/server/services/ai.service';

/** Fetched in full. Beyond this the answer is padded rather than better. */
const PAGES_TO_READ = 5;
/** Returned to the interface, including those never fetched. */
const SOURCES_TO_SHOW = 8;

export interface WebSearchResult {
  answer: string;
  sources: (Source & { index: number; wasRead: boolean })[];
  /** What could not be retrieved, so the interface can be honest about coverage. */
  unreachable: number;
  query: string;
  tookMs: number;
}

const provider = new SerperProvider();

/** Whether web search can run at all — the mode's availability depends on it. */
export function isWebSearchConfigured(): boolean {
  return provider.isConfigured();
}

export async function searchWeb(input: {
  userId: string;
  query: string;
  locale: 'ar' | 'en';
  /** Skip fetching and answer from snippets — faster, and much shallower. */
  quick?: boolean;
}): Promise<WebSearchResult> {
  const startedAt = Date.now();

  if (!provider.isConfigured()) {
    throw new AppError(
      'VALIDATION',
      'Web search is not configured on this deployment.',
      'البحث في الويب غير مهيّأ في هذا النظام.',
      { reasonKey: 'knowledge.error.notConfigured' },
    );
  }

  const outcome = await provider.search({
    text: input.query,
    language: input.locale,
    kind: 'web',
    limit: SOURCES_TO_SHOW,
  });

  if (outcome.error) {
    /*
     * A provider failure is reported with its own reason rather than as a
     * generic error, because the three cases need different responses from the
     * user: rate-limited means wait, unauthorised means the key is wrong, and a
     * timeout means try again.
     */
    throw new AppError(
      'INTERNAL',
      'The web search could not be completed.',
      'تعذّر إكمال البحث في الويب.',
      { reasonKey: outcome.error.reasonKey },
    );
  }

  if (outcome.sources.length === 0) {
    return {
      answer: '',
      sources: [],
      unreachable: 0,
      query: input.query,
      tookMs: Date.now() - startedAt,
    };
  }

  /*
   * Only the top few are fetched. Reading eight pages costs eight seconds and
   * adds little: results after the fifth are rarely what the answer rests on,
   * and they are still shown so the researcher can open them.
   */
  const toRead = input.quick ? [] : outcome.sources.slice(0, PAGES_TO_READ);
  const { fetched, failed } = toRead.length > 0
    ? await fetchSources(toRead.map((source) => source.url))
    : { fetched: [], failed: [] };

  const contentByUrl = new Map(fetched.map((page) => [page.url, page]));

  const numbered = outcome.sources.map((source, index) => ({
    ...source,
    index: index + 1,
    wasRead: contentByUrl.has(source.url),
  }));

  const answer = await answerFromSources({
    userId: input.userId,
    question: input.query,
    locale: input.locale,
    sources: numbered.map((source) => ({
      index: source.index,
      title: source.title,
      url: source.url,
      site: source.container ?? '',
      /*
       * The fetched text where there is one, the snippet where there is not.
       * Marked as which, so the model can weigh a full page against two lines
       * rather than treating them alike.
       */
      content: contentByUrl.get(source.url)?.text ?? source.snippet ?? '',
      full: contentByUrl.has(source.url),
    })),
  });

  logger.info('webSearch.completed', {
    query: input.query.slice(0, 80),
    found: outcome.sources.length,
    read: fetched.length,
    unreachable: failed.length,
    ms: Date.now() - startedAt,
  });

  return {
    answer,
    sources: numbered.slice(0, SOURCES_TO_SHOW),
    unreachable: failed.length,
    query: input.query,
    tookMs: Date.now() - startedAt,
  };
}
