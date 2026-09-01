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
import { recordTurn } from '@/server/services/chat.service';
import { assertCanUseAI, recordSimple } from '@/server/services/usage.service';

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
  /** The conversation to record the turn in, when there is one. */
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<WebSearchResult> {
  const startedAt = Date.now();

  /*
   * Metered before the work, not after.
   *
   * A search costs a provider credit and up to five page fetches whether or not
   * the answer is any good, so a user who is out of quota should be told before
   * the credit is spent rather than after.
   */
  await assertCanUseAI(input.userId, 800);

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

  /*
   * Recorded in the conversation, like any other turn.
   *
   * This mode bypasses the agent — deliberately, so a phrasing the classifier
   * reads as a general question cannot answer from memory instead of sources —
   * and in bypassing it, it bypassed persistence too. A refresh emptied the
   * search from the thread, which is the same defect the agent had before it
   * was wired up, reappearing in a path that went around the fix.
   *
   * Failures are swallowed: an answer that was delivered and then failed to
   * save is a storage problem, not a reason to lose the answer.
   */
  if (input.conversationId) {
    await recordTurn({
      conversationId: input.conversationId,
      userId: input.userId,
      userMessage: input.query,
      assistantMessage: answer,
      payload: {
        results: [
          {
            kind: 'webSources',
            payload: { sources: numbered.slice(0, SOURCES_TO_SHOW), unreachable: failed.length },
          },
        ],
      },
    }).catch((error: unknown) => {
      logger.error('webSearch.persistFailed', {
        conversationId: input.conversationId,
        error: String(error),
      });
    });
  }

  /*
   * Recorded as a tool run rather than as an AI request.
   *
   * The model call inside is already metered by `answerFromSources`; this
   * counts the search itself, which costs a provider credit and page fetches
   * that no existing metric covers. Reusing `TOOL_RUN` rather than adding a
   * metric keeps it inside the plan limits that already exist — introducing a
   * new one would be a pricing decision, and that is not mine to make.
   */
  await recordSimple(input.userId, 'TOOL_RUN', 1, input.projectId ?? undefined).catch(
    () => undefined,
  );

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
