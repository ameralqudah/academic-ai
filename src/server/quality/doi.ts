/**
 * Checking whether a DOI resolves to what the reference claims.
 *
 * This is the check that catches an invented reference, because a DOI is the
 * one part that cannot be plausibly guessed: `10.1016/j.chb.2019.04.011` either
 * resolves to a real record or it does not.
 *
 * **It is never a requirement.** Verification runs when a DOI is present. A
 * reference without one is checked structurally and left alone — see
 * `sources.ts` for why demanding DOIs would flag most legitimate books,
 * reports and theses.
 *
 * **Four outcomes, and the distinction between the last two matters.** A DOI
 * that resolves is verified. One Crossref does not know is unregistered, which
 * for a claimed journal article is a serious finding. But a network failure is
 * neither — reporting "could not check" is honest, and reporting it as
 * unregistered would accuse a real source because a request timed out.
 */

import { logger } from '@/lib/logger';

import { normaliseDoi, isWellFormedDoi, type Reference } from './sources';

/** Crossref answers fast or not at all; waiting longer helps nobody. */
const TIMEOUT_MS = 8000;
/** Checked in parallel. Crossref asks for politeness, not silence. */
const MAX_CONCURRENT = 4;

export type DoiStatus =
  /** Resolves, and the record matches what the reference says. */
  | 'verified'
  /** Resolves, but the title or year differs from the reference. */
  | 'mismatch'
  /** Crossref has no record. For a claimed journal article, this is serious. */
  | 'not-found'
  /** The string is not a DOI at all. */
  | 'malformed'
  /**
   * Could not be checked — a timeout, a rate limit, an outage.
   *
   * Deliberately distinct from `not-found`. Treating an unreachable service as
   * evidence against a source would accuse real references of being invented
   * every time the network hiccups.
   */
  | 'unchecked';

export interface DoiResult {
  referenceId: string;
  doi: string;
  status: DoiStatus;
  /** What Crossref holds, when it holds anything. */
  registered?: {
    title?: string;
    year?: number;
    container?: string;
    type?: string;
  };
  /** Which fields disagree, for a `mismatch`. */
  differences?: string[];
  /** Why it could not be checked, for `unchecked`. */
  reason?: string;
}

/*
 * A process-lifetime cache.
 *
 * The same DOI appears in a bibliography, in a draft, and in the final check —
 * three requests for one answer. Not persisted: DOI records barely change, and
 * a table to store them would be infrastructure for a problem that does not
 * exist at this scale.
 */
const cache = new Map<string, DoiResult>();

export function clearDoiCache(): void {
  cache.clear();
}

/**
 * Verifies the DOIs among a set of references.
 *
 * References without a DOI are skipped silently rather than being reported as
 * unverifiable — they were never claiming to have one.
 */
export async function verifyDois(references: Reference[]): Promise<DoiResult[]> {
  const withDoi = references.filter((reference) => reference.doi);
  const results: DoiResult[] = [];

  for (let start = 0; start < withDoi.length; start += MAX_CONCURRENT) {
    const batch = withDoi.slice(start, start + MAX_CONCURRENT);
    results.push(...(await Promise.all(batch.map((reference) => verifyOne(reference)))));
  }

  return results;
}

export async function verifyOne(reference: Reference): Promise<DoiResult> {
  const raw = reference.doi as string;

  if (!isWellFormedDoi(raw)) {
    return { referenceId: reference.id, doi: raw, status: 'malformed' };
  }

  const doi = normaliseDoi(raw);
  const cached = cache.get(doi);

  if (cached) return { ...cached, referenceId: reference.id };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      signal: controller.signal,
      headers: {
        /*
         * Crossref's polite pool: identifying the caller gets better service
         * and is what they ask for. Anonymous requests are rate-limited harder
         * and can be dropped under load.
         */
        'user-agent':
          'AcademicAI/1.0 (https://academic-ai-app.onrender.com; mailto:support@academic-ai-app.onrender.com)',
        accept: 'application/json',
      },
    });

    if (response.status === 404) {
      const result: DoiResult = { referenceId: reference.id, doi, status: 'not-found' };
      cache.set(doi, result);
      return result;
    }

    if (!response.ok) {
      /*
       * Not cached. A rate limit now says nothing about the DOI, and caching it
       * would keep a real source marked unchecked for the rest of the session.
       */
      logger.info('doi.checkFailed', { doi, status: response.status });

      return {
        referenceId: reference.id,
        doi,
        status: 'unchecked',
        reason: `HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as { message?: CrossrefWork };
    const work = payload.message;

    if (!work) {
      return { referenceId: reference.id, doi, status: 'unchecked', reason: 'empty response' };
    }

    const registered = {
      title: work.title?.[0],
      year: work.issued?.['date-parts']?.[0]?.[0],
      container: work['container-title']?.[0],
      type: work.type,
    };

    const differences = compare(reference, registered);

    const result: DoiResult = {
      referenceId: reference.id,
      doi,
      status: differences.length > 0 ? 'mismatch' : 'verified',
      registered,
      ...(differences.length > 0 ? { differences } : {}),
    };

    cache.set(doi, result);
    return result;
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';

    return {
      referenceId: reference.id,
      doi,
      status: 'unchecked',
      reason: aborted ? 'timeout' : String(error).slice(0, 120),
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface CrossrefWork {
  title?: string[];
  'container-title'?: string[];
  issued?: { 'date-parts'?: number[][] };
  type?: string;
}

/**
 * Which fields disagree between the reference and the registered record.
 *
 * Deliberately tolerant. Titles differ in punctuation, capitalisation and
 * subtitle handling between citation styles, and a year can be off by one
 * between online-first and issue publication. Flagging those would produce a
 * mismatch on most correct references, and a check that cries wolf is a check
 * nobody reads.
 */
function compare(reference: Reference, registered: DoiResult['registered']): string[] {
  const differences: string[] = [];

  if (reference.title && registered?.title) {
    const a = simplify(reference.title);
    const b = simplify(registered.title);

    /*
     * Containment rather than equality: "Digital transformation" against
     * "Digital transformation: a review" is the same paper cited two ways.
     */
    if (!a.includes(b) && !b.includes(a) && overlap(a, b) < 0.6) {
      differences.push('title');
    }
  }

  /*
   * A year off by one is normal — online-first against issue date. Two or more
   * is a different paper.
   */
  if (reference.year && registered?.year && Math.abs(reference.year - registered.year) > 1) {
    differences.push('year');
  }

  return differences;
}

function simplify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Proportion of the shorter title's words that appear in the longer. */
function overlap(a: string, b: string): number {
  const first = new Set(a.split(' ').filter((word) => word.length > 3));
  const second = new Set(b.split(' ').filter((word) => word.length > 3));

  if (first.size === 0 || second.size === 0) return 1;

  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;

  return shared / Math.min(first.size, second.size);
}

/**
 * How serious a DOI result is, given what the reference claims to be.
 *
 * The same status means different things for different sources. A journal
 * article whose DOI is unregistered is a strong sign of invention; a dataset
 * with a mistyped DOI is a typo. The kind decides.
 */
export function severityOf(result: DoiResult, reference: Reference): 'error' | 'warning' | 'info' {
  if (result.status === 'verified') return 'info';

  /* Unreachable service: not the reference's fault, and not a finding. */
  if (result.status === 'unchecked') return 'info';

  if (result.status === 'malformed') return 'error';

  if (result.status === 'not-found') {
    return reference.kind === 'journal-article' ? 'error' : 'warning';
  }

  /* A mismatch is always worth a look — it may be the wrong DOI on a real paper. */
  return 'warning';
}
