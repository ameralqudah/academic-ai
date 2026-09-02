/**
 * What counts as a source, and what each kind needs.
 *
 * The first version of this checked one thing: does the reference have a DOI?
 * That is wrong in a way that would have damaged the product. A DOI is an
 * identifier for items registered with a DOI agency — overwhelmingly journal
 * articles and recent conference proceedings. Books mostly have ISBNs, reports
 * and theses usually have neither, and a government statistical release has a
 * URL and nothing else. All of them are legitimate scholarly sources, and a
 * checker that flagged every one as suspect would train researchers to ignore
 * it, which is worse than not checking at all.
 *
 * So each kind declares what it actually needs, and whether a DOI is *expected*
 * — a journal article without one is worth a note, a book without one is
 * normal.
 */

export type SourceKind =
  | 'journal-article'
  | 'book'
  | 'book-chapter'
  | 'conference-paper'
  | 'report'
  | 'thesis'
  | 'website'
  | 'dataset'
  | 'preprint'
  | 'unknown';

export interface Reference {
  /** The key used to cite it in the text: `[1]`, `(Smith, 2020)`. */
  id: string;
  kind: SourceKind;
  title?: string;
  authors?: string[];
  year?: number;
  /** Journal, book, proceedings, or publisher — whatever contains it. */
  container?: string;
  publisher?: string;
  doi?: string;
  isbn?: string;
  url?: string;
  pages?: string;
  volume?: string;
  issue?: string;
  /** Where it came from: a search result, or the user's own bibliography. */
  provenance?: 'retrieved' | 'user-provided' | 'generated';
}

interface KindProfile {
  /** Fields without which the reference cannot be checked or found again. */
  required: (keyof Reference)[];
  /**
   * Whether a missing DOI is worth mentioning.
   *
   * True only where the absence is unusual. A 2021 journal article without one
   * is worth a second look; a 1987 book without one is simply a book.
   */
  doiExpected: boolean;
  /** Something that identifies it well enough to be found: DOI, ISBN, or URL. */
  needsLocator: boolean;
}

const PROFILES: Record<SourceKind, KindProfile> = {
  /*
   * Journal articles are the case where a missing DOI means something. Nearly
   * everything published since roughly 2000 in a real journal has one, so its
   * absence is either an old article, an unindexed venue, or a reference that
   * was not retrieved from anywhere.
   */
  'journal-article': {
    required: ['title', 'authors', 'year', 'container'],
    doiExpected: true,
    needsLocator: false,
  },
  book: {
    required: ['title', 'authors', 'year', 'publisher'],
    doiExpected: false,
    needsLocator: false,
  },
  'book-chapter': {
    required: ['title', 'authors', 'year', 'container'],
    doiExpected: false,
    needsLocator: false,
  },
  /* Recent proceedings are often registered; older ones are not. */
  'conference-paper': {
    required: ['title', 'authors', 'year', 'container'],
    doiExpected: false,
    needsLocator: false,
  },
  /*
   * Institutional and government reports: the publisher is what makes them
   * citable, and a URL is how a reader reaches them.
   */
  report: {
    required: ['title', 'year', 'publisher'],
    doiExpected: false,
    needsLocator: true,
  },
  thesis: {
    required: ['title', 'authors', 'year', 'publisher'],
    doiExpected: false,
    needsLocator: false,
  },
  /* A web page with no URL cannot be checked by anyone. */
  website: {
    required: ['title', 'url'],
    doiExpected: false,
    needsLocator: true,
  },
  dataset: {
    required: ['title', 'year'],
    doiExpected: false,
    needsLocator: true,
  },
  preprint: {
    required: ['title', 'authors', 'year'],
    doiExpected: false,
    needsLocator: true,
  },
  /*
   * Unknown is deliberately permissive. A reference this cannot categorise is
   * not thereby suspect — it is uncategorised, and demanding fields of it would
   * flag legitimate sources for the crime of being unusual.
   */
  unknown: {
    required: ['title'],
    doiExpected: false,
    needsLocator: false,
  },
};

export function profileFor(kind: SourceKind): KindProfile {
  return PROFILES[kind] ?? PROFILES.unknown;
}

export interface SourceIssue {
  referenceId: string;
  code:
    | 'missing-field'
    | 'no-locator'
    | 'doi-expected'
    | 'malformed-doi'
    | 'malformed-year'
    | 'suspicious-pattern';
  severity: 'error' | 'warning' | 'info';
  /** What is wrong, and what the researcher should do about it. */
  detail: Record<string, string | number>;
}

/**
 * Checks a reference's shape, without touching the network.
 *
 * Structural only: whether the fields a source of this kind needs are present,
 * and whether anything looks malformed. Whether the DOI resolves is a separate
 * question answered in `doi.ts`, because that costs a request and this does not.
 */
export function checkReferenceShape(reference: Reference): SourceIssue[] {
  const issues: SourceIssue[] = [];
  const profile = profileFor(reference.kind);

  for (const field of profile.required) {
    const value = reference[field];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);

    if (empty) {
      issues.push({
        referenceId: reference.id,
        /*
         * A warning, not an error. An incomplete reference is a reference the
         * researcher needs to finish, not evidence of fabrication — and calling
         * it an error would put a red mark on half of anyone's working
         * bibliography.
         */
        code: 'missing-field',
        severity: 'warning',
        detail: { field, kind: reference.kind },
      });
    }
  }

  if (profile.needsLocator && !reference.doi && !reference.url && !reference.isbn) {
    issues.push({
      referenceId: reference.id,
      code: 'no-locator',
      severity: 'warning',
      detail: { kind: reference.kind },
    });
  }

  /*
   * A journal article with no DOI: informational, not a warning.
   *
   * It is worth a glance and it is not a problem — plenty of legitimate
   * articles predate DOI registration or appear in venues that never
   * registered. Ranking this as a warning would bury the findings that matter.
   */
  if (profile.doiExpected && !reference.doi) {
    issues.push({
      referenceId: reference.id,
      code: 'doi-expected',
      severity: 'info',
      detail: { kind: reference.kind, year: reference.year ?? 0 },
    });
  }

  if (reference.doi && !isWellFormedDoi(reference.doi)) {
    issues.push({
      referenceId: reference.id,
      code: 'malformed-doi',
      severity: 'error',
      detail: { doi: reference.doi.slice(0, 80) },
    });
  }

  if (reference.year !== undefined) {
    const now = new Date().getFullYear();

    /*
     * A future year, or one before printing. Both indicate a typo or an
     * invented reference, and both are worth stopping on — unlike a missing
     * field, this cannot be true.
     */
    if (reference.year > now + 1 || reference.year < 1400) {
      issues.push({
        referenceId: reference.id,
        code: 'malformed-year',
        severity: 'error',
        detail: { year: reference.year },
      });
    }
  }

  return issues;
}

/**
 * Whether a DOI has the right shape.
 *
 * `10.` then a registrant number, a slash, and a suffix. Checked before any
 * network call: a malformed DOI is malformed whether or not Crossref is
 * reachable, and asking Crossref about it wastes a request.
 */
export function isWellFormedDoi(doi: string): boolean {
  const cleaned = doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');

  return /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i.test(cleaned);
}

/** A DOI with its URL prefix and `doi:` label stripped. */
export function normaliseDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

/**
 * Signals that a reference may have been invented rather than retrieved.
 *
 * **Reported, never acted on.** Every signal here has honest explanations — a
 * researcher typing a reference from memory produces several of them — so this
 * says "worth checking", not "fabricated". Deleting or rewriting on this basis
 * would remove real sources, which is a worse failure than showing a flag
 * somebody dismisses.
 */
export function fabricationSignals(reference: Reference): string[] {
  const signals: string[] = [];

  /*
   * Generated provenance with no locator at all. The strongest signal here,
   * because a model asked for references produces exactly this: a plausible
   * title, plausible authors, and nothing anyone can look up.
   */
  if (
    reference.provenance === 'generated' &&
    !reference.doi &&
    !reference.url &&
    !reference.isbn
  ) {
    signals.push('generated-without-locator');
  }

  /* A title that reads as a placeholder rather than a paper. */
  if (reference.title && /^(title|untitled|reference|article)\b/i.test(reference.title.trim())) {
    signals.push('placeholder-title');
  }

  /*
   * Author names that are initials only, or repeat. A real author list rarely
   * looks like "A. A., B. B." — a generated one often does.
   */
  if (reference.authors && reference.authors.length > 1) {
    const unique = new Set(reference.authors.map((author) => author.trim().toLowerCase()));
    if (unique.size < reference.authors.length) signals.push('duplicate-authors');
  }

  /*
   * A DOI whose registrant prefix is not one that exists. Only the obviously
   * invented ones — 10.0000 and 10.1111/xxxx — because a real prefix this does
   * not recognise is far more likely than an invented one that happens to look
   * real.
   */
  if (reference.doi) {
    const normalised = normaliseDoi(reference.doi);
    if (/^10\.0+\//.test(normalised) || /\/x{4,}/i.test(normalised)) {
      signals.push('implausible-doi');
    }
  }

  return signals;
}

/**
 * Guesses a source's kind from what it carries.
 *
 * Used when a reference arrives without one — from a user's bibliography, or a
 * search result whose provider does not say. Falls back to `unknown` rather
 * than guessing `journal-article`, because guessing that would apply the DOI
 * expectation to books and fill the report with noise.
 */
export function inferKind(reference: Partial<Reference>): SourceKind {
  if (reference.kind && reference.kind !== 'unknown') return reference.kind;

  if (reference.isbn) return reference.container ? 'book-chapter' : 'book';

  const container = (reference.container ?? '').toLowerCase();

  if (/proceedings|conference|symposium|workshop/.test(container)) return 'conference-paper';
  if (/thesis|dissertation/.test(container)) return 'thesis';
  if (/arxiv|biorxiv|ssrn|preprint/.test(container)) return 'preprint';
  if (/journal|review|quarterly|transactions|letters/.test(container)) return 'journal-article';

  if (reference.doi && reference.container) return 'journal-article';

  if (reference.url && !reference.doi && !reference.container) return 'website';

  return 'unknown';
}
