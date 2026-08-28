/**
 * The vocabulary of retrieved knowledge.
 *
 * One shape for everything the product can look up — a journal article from
 * Crossref, a work from OpenAlex, and later a web page from a search provider.
 * They are different things, and forcing them into one type is a decision worth
 * defending rather than assuming.
 *
 * The defence is what happens downstream. Every consumer treats a source the
 * same way: the interface renders a citation card, the merger removes
 * duplicates, and the writing agent receives a list of things it may cite and
 * nothing else. Three consumers that would otherwise need a branch per source
 * type, and would grow a new branch each time a provider is added.
 *
 * What the shape must carry, and why each field is not optional decoration:
 *
 * **`url` and `doi`.** A source the researcher cannot open is not a source. The
 * DOI matters more than the URL for academic work — it is the only identifier
 * stable enough to deduplicate across providers that describe the same paper
 * three different ways.
 *
 * **`language`.** So the interface can mark which sources an Arabic thesis can
 * cite directly, and so the answer can say honestly when the Arabic literature
 * came back thin.
 *
 * **`retrievedAt`.** A retrieved fact has a date. Six months later, "current"
 * meant something else.
 */

export type SourceKind =
  /** A journal article, book chapter, conference paper — anything with a DOI. */
  | 'academic'
  /** An ordinary web page. */
  | 'web'
  /** A news article, where recency is part of what makes it relevant. */
  | 'news';

export type SourceLanguage = 'ar' | 'en' | 'other' | 'unknown';

export interface Source {
  kind: SourceKind;
  title: string;
  /** Where the researcher can read it. */
  url: string;
  /** The stable identifier, when the source has one. Deduplication depends on it. */
  doi?: string;
  /** Abstract or snippet — enough for the model to judge relevance without fetching. */
  snippet?: string;
  authors?: string[];
  /** Journal, publisher, or site name. */
  container?: string;
  year?: number;
  publishedAt?: string;
  language: SourceLanguage;
  citationCount?: number;
  /** True when a full text is freely readable — worth surfacing to a student. */
  openAccess?: boolean;
  /** Which provider returned it, for attribution and for debugging coverage. */
  provider: string;
  /** The provider's own relevance figure, on its own scale. Not comparable across providers. */
  score?: number;
  retrievedAt: string;
}

export interface SearchQuery {
  text: string;
  /** Language of the query itself, which is not always the user's language. */
  language: SourceLanguage;
  kind?: SourceKind;
  limit?: number;
  /** Restrict to work published from this year onward. */
  fromYear?: number;
}

export interface SearchOutcome {
  sources: Source[];
  /** What the provider reports it has, which is usually far more than it returns. */
  totalAvailable: number | null;
  provider: string;
  /** Set when the provider failed. The search continues with whatever else worked. */
  error?: { reasonKey: string; detail?: string };
  tookMs: number;
}

export interface KnowledgeProvider {
  readonly name: string;
  readonly kinds: readonly SourceKind[];

  /**
   * Whether the provider can be used.
   *
   * Some need a key and some do not, and the difference must not leak into the
   * caller. Crossref works with nothing configured; OpenAlex works better with
   * a key and still works without one.
   */
  isConfigured(): boolean;

  search(query: SearchQuery): Promise<SearchOutcome>;
}

/**
 * Raised only for programming errors — a malformed query, a missing required
 * option. A provider being down is not an error: it is a `SearchOutcome` with
 * an `error` field, so one failing source never takes down a search that other
 * sources could still answer.
 */
export class KnowledgeError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(reasonKey);
    this.name = 'KnowledgeError';
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Normalises a DOI so the same paper from two providers compares equal.
 *
 * They disagree constantly on presentation: Crossref returns a bare
 * `10.1109/4235.585892`, OpenAlex wraps it as `https://doi.org/10.1109/...`,
 * and case varies. The DOI standard is case-insensitive, so lowercasing is
 * correct rather than merely convenient.
 */
export function normaliseDoi(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const stripped = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();

  return stripped.startsWith('10.') ? stripped : undefined;
}

/**
 * Guesses the language of a title from its script.
 *
 * Script rather than a language model, for the same reason the chat detects
 * language by counting Arabic characters: it is a settled question that costs
 * nothing to answer correctly. A title with any meaningful proportion of Arabic
 * letters is Arabic; the providers' own language fields are unreliable — the
 * OpenAlex language metadata is documented as over-reporting English.
 */
export function detectLanguage(text: string | null | undefined): SourceLanguage {
  if (!text) return 'unknown';

  const arabic = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;

  if (arabic === 0 && latin === 0) return 'unknown';
  if (arabic > latin * 0.3) return 'ar';
  if (latin > 0) return 'en';
  return 'other';
}

/** Strips the markup Crossref and others leave inside abstracts. */
export function cleanAbstract(value: string | null | undefined, maxLength = 600): string | undefined {
  if (!value) return undefined;

  const text = value
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length === 0) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
