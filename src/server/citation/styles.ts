/**
 * Formatting a reference in a citation style.
 *
 * Styles are declared as data rather than written as functions, because the
 * requirement is that an institutional style can be added later without
 * redesigning anything. A university with its own thesis manual should be a new
 * entry in a table, not a new branch in a formatter — and if adding Yarmouk's
 * style meant editing the code that formats APA, every institution added would
 * risk breaking every one already there.
 *
 * So a style is a set of rules: how authors are ordered and abbreviated, where
 * the year goes, what gets italicised, how the pieces are joined. The formatter
 * reads those rules and knows nothing about APA specifically.
 *
 * **The output is plain text with light markers.** `*italic*` and `**bold**`,
 * which the document generators translate into real formatting. Producing
 * Word-specific runs here would mean a second implementation for PDF and a
 * third for Markdown.
 */

import type { Reference } from '@/server/quality/sources';

export type StyleId = 'apa' | 'ieee' | 'harvard' | 'chicago' | 'mla';

type AuthorFormat =
  /** Smith, J. A. — surname first, initials. */
  | 'surname-initials'
  /** J. A. Smith — initials first. */
  | 'initials-surname'
  /** Smith, John A. — surname first, full given names. */
  | 'surname-full';

interface StyleRules {
  id: StyleId;
  label: string;
  /** Numbered like `[1]`, or author-year like `(Smith, 2020)`. */
  citationForm: 'numeric' | 'author-year';
  authorFormat: AuthorFormat;
  /** Beyond this many, the rest become "et al." Zero means never. */
  etAlAfter: number;
  /** How many are listed before "et al." appears. */
  etAlShow: number;
  /** `(2020).` after the authors, or `2020.` at the end. */
  yearPosition: 'after-authors' | 'at-end';
  /** How the year is wrapped when it follows the authors. */
  yearWrapper: 'parentheses' | 'bare';
  /**
   * What joins the last two authors.
   *
   * A small thing that a reader notices immediately: IEEE writes "and", APA
   * writes an ampersand, and a reference with the wrong one reads as the wrong
   * style however correct the rest is.
   */
  authorJoin: 'ampersand' | 'and';
  /** The container: journal name, book title. */
  containerStyle: 'italic' | 'plain' | 'quoted';
  /** The item's own title. */
  titleStyle: 'plain' | 'quoted' | 'italic';
  /** Sentence case for titles, or title case. */
  titleCase: 'sentence' | 'title' | 'as-written';
  /** How the DOI is written, when there is one. */
  doiForm: 'url' | 'prefixed' | 'bare' | 'omit';
  /** The reference list is ordered by this. */
  ordering: 'alphabetical' | 'citation-order';
}

/**
 * The five styles, as rules.
 *
 * Each entry encodes what its manual specifies. They are deliberately
 * incomplete: a full APA implementation covers dozens of source types with
 * their own quirks, and this covers the ones a thesis actually uses. What it
 * gets right is the shape — a reader recognises the style, and a supervisor's
 * corrections are edits rather than a rewrite.
 */
const STYLES: Record<StyleId, StyleRules> = {
  apa: {
    id: 'apa',
    authorJoin: 'ampersand',
    label: 'APA 7th',
    citationForm: 'author-year',
    authorFormat: 'surname-initials',
    /* APA lists up to 20 and elides the middle; simplified to et al. after 20. */
    etAlAfter: 20,
    etAlShow: 19,
    yearPosition: 'after-authors',
    yearWrapper: 'parentheses',
    containerStyle: 'italic',
    titleStyle: 'plain',
    titleCase: 'sentence',
    doiForm: 'url',
    ordering: 'alphabetical',
  },
  ieee: {
    id: 'ieee',
    authorJoin: 'and',
    label: 'IEEE',
    citationForm: 'numeric',
    authorFormat: 'initials-surname',
    etAlAfter: 6,
    etAlShow: 3,
    yearPosition: 'at-end',
    yearWrapper: 'bare',
    containerStyle: 'italic',
    titleStyle: 'quoted',
    titleCase: 'as-written',
    doiForm: 'prefixed',
    ordering: 'citation-order',
  },
  harvard: {
    id: 'harvard',
    authorJoin: 'ampersand',
    label: 'Harvard',
    citationForm: 'author-year',
    authorFormat: 'surname-initials',
    etAlAfter: 4,
    etAlShow: 3,
    yearPosition: 'after-authors',
    yearWrapper: 'parentheses',
    containerStyle: 'italic',
    titleStyle: 'plain',
    titleCase: 'sentence',
    doiForm: 'url',
    ordering: 'alphabetical',
  },
  chicago: {
    id: 'chicago',
    authorJoin: 'and',
    label: 'Chicago (author-date)',
    citationForm: 'author-year',
    authorFormat: 'surname-full',
    etAlAfter: 4,
    etAlShow: 3,
    yearPosition: 'after-authors',
    yearWrapper: 'bare',
    containerStyle: 'italic',
    titleStyle: 'quoted',
    titleCase: 'title',
    doiForm: 'url',
    ordering: 'alphabetical',
  },
  mla: {
    id: 'mla',
    authorJoin: 'and',
    label: 'MLA 9th',
    citationForm: 'author-year',
    authorFormat: 'surname-full',
    etAlAfter: 3,
    etAlShow: 1,
    yearPosition: 'at-end',
    yearWrapper: 'bare',
    containerStyle: 'italic',
    titleStyle: 'quoted',
    titleCase: 'title',
    doiForm: 'bare',
    ordering: 'alphabetical',
  },
};

export function styleById(id: StyleId): StyleRules {
  return STYLES[id] ?? STYLES.apa;
}

export function availableStyles(): { id: StyleId; label: string }[] {
  return Object.values(STYLES).map((style) => ({ id: style.id, label: style.label }));
}

/**
 * Registers an additional style at runtime.
 *
 * The extension point the requirement asks for: an institution's manual becomes
 * a rules object, and nothing that formats the existing five changes. Kept as a
 * function rather than a config file because a style will eventually come from
 * the database, and this is where that will attach.
 */
export function registerStyle(rules: StyleRules): void {
  (STYLES as Record<string, StyleRules>)[rules.id] = rules;
}

/* -------------------------------------------------------------------------- */
/*                                 Formatting                                 */
/* -------------------------------------------------------------------------- */

/**
 * One reference, formatted.
 *
 * Missing fields are skipped rather than filled with placeholders. A reference
 * without a year should read as incomplete, not as "(n.d.)" — which looks
 * deliberate and hides that something is missing. The quality engine reports
 * the gap; this does not paper over it.
 */
export function formatReference(reference: Reference, styleId: StyleId): string {
  const style = styleById(styleId);
  const parts: string[] = [];

  const authors = formatAuthors(reference.authors ?? [], style);
  if (authors) parts.push(authors);

  if (style.yearPosition === 'after-authors' && reference.year) {
    parts.push(style.yearWrapper === 'parentheses' ? `(${reference.year}).` : `${reference.year}.`);
  }

  const title = applyCase(reference.title ?? '', style.titleCase);
  if (title) parts.push(wrap(title, style.titleStyle) + '.');

  /*
   * The container and its trimmings vary by source kind, which is where a
   * single formatter would otherwise become a pile of conditionals. Kept
   * shallow: journal-like sources get volume and issue, book-like sources get a
   * publisher.
   */
  if (reference.container) {
    const container = wrap(reference.container, style.containerStyle);
    const volume = reference.volume
      ? `, ${wrap(reference.volume, style.containerStyle)}${reference.issue ? `(${reference.issue})` : ''}`
      : '';
    const pages = reference.pages ? `, ${reference.pages}` : '';

    parts.push(`${container}${volume}${pages}.`);
  } else if (reference.publisher) {
    parts.push(`${reference.publisher}.`);
  }

  if (style.yearPosition === 'at-end' && reference.year) {
    parts.push(`${reference.year}.`);
  }

  const locator = formatLocator(reference, style);
  if (locator) parts.push(locator);

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The in-text citation.
 *
 * Numeric styles need the reference's position in the list, which the caller
 * supplies — the formatter has no view of the whole document.
 */
export function formatCitation(
  reference: Reference,
  styleId: StyleId,
  position: number,
): string {
  const style = styleById(styleId);

  if (style.citationForm === 'numeric') return `[${position}]`;

  const first = reference.authors?.[0];
  const surname = first ? surnameOf(first) : (reference.title ?? '').split(' ').slice(0, 2).join(' ');

  const etAl = (reference.authors?.length ?? 0) > 2 ? ' et al.' : '';
  const year = reference.year ? `, ${reference.year}` : '';

  return `(${surname}${etAl}${year})`;
}

/** The reference list, ordered as the style requires. */
export function formatReferenceList(
  references: Reference[],
  styleId: StyleId,
): { id: string; position: number; formatted: string }[] {
  const style = styleById(styleId);

  const ordered =
    style.ordering === 'alphabetical'
      ? [...references].sort((a, b) => {
          const first = surnameOf(a.authors?.[0] ?? a.title ?? '');
          const second = surnameOf(b.authors?.[0] ?? b.title ?? '');
          return first.localeCompare(second, 'en');
        })
      : [...references];

  return ordered.map((reference, index) => ({
    id: reference.id,
    position: index + 1,
    formatted: `${style.citationForm === 'numeric' ? `[${index + 1}] ` : ''}${formatReference(reference, styleId)}`,
  }));
}

/* -------------------------------------------------------------------------- */

function formatAuthors(authors: string[], style: StyleRules): string {
  if (authors.length === 0) return '';

  const shown =
    style.etAlAfter > 0 && authors.length > style.etAlAfter
      ? authors.slice(0, style.etAlShow)
      : authors;

  const formatted = shown.map((author) => formatOneAuthor(author, style.authorFormat));

  const elided = shown.length < authors.length;

  if (elided) return `${formatted.join(', ')}, et al.`;
  if (formatted.length === 1) return `${formatted[0]}`;

  const last = formatted[formatted.length - 1];
  const join = style.authorJoin === 'and' ? 'and' : '&';

  return `${formatted.slice(0, -1).join(', ')}, ${join} ${last}`;
}

/**
 * One author's name.
 *
 * Handles "Surname, Given" and "Given Surname" as input, because references
 * arrive both ways — from a search provider in one form and from a user's
 * bibliography in the other.
 */
function formatOneAuthor(author: string, format: AuthorFormat): string {
  const trimmed = author.trim();
  if (trimmed.length === 0) return '';

  let surname: string;
  let given: string;

  if (trimmed.includes(',')) {
    const [first, ...rest] = trimmed.split(',');
    surname = (first ?? '').trim();
    given = rest.join(',').trim();
  } else {
    const words = trimmed.split(/\s+/);
    surname = words[words.length - 1] ?? '';
    given = words.slice(0, -1).join(' ');
  }

  const initials = given
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}.`)
    .join(' ');

  if (format === 'initials-surname') return initials ? `${initials} ${surname}` : surname;
  if (format === 'surname-full') return given ? `${surname}, ${given}` : surname;

  return initials ? `${surname}, ${initials}` : surname;
}

function surnameOf(author: string): string {
  const trimmed = author.trim();
  if (trimmed.includes(',')) return (trimmed.split(',')[0] ?? '').trim();

  const words = trimmed.split(/\s+/);
  return words[words.length - 1] ?? trimmed;
}

function wrap(text: string, wrapper: StyleRules['titleStyle'] | StyleRules['containerStyle']): string {
  if (wrapper === 'italic') return `*${text}*`;
  if (wrapper === 'quoted') return `"${text}"`;
  return text;
}

/**
 * Title casing.
 *
 * Sentence case lowercases everything after the first word except what looks
 * like a proper noun — which cannot be done reliably, so a word already
 * capitalised mid-title is left alone. The alternative, lowercasing everything,
 * turns "Digital Transformation in Jordan" into "...in jordan".
 */
function applyCase(text: string, mode: StyleRules['titleCase']): string {
  if (!text || mode === 'as-written') return text;

  if (mode === 'title') {
    const minor = new Set([
      'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to',
      'from', 'by', 'of', 'in', 'with',
    ]);

    return text
      .split(/\s+/)
      .map((word, index) =>
        index > 0 && minor.has(word.toLowerCase())
          ? word.toLowerCase()
          : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join(' ');
  }

  /* Sentence case: first word capitalised, the rest left as written. */
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatLocator(reference: Reference, style: StyleRules): string {
  if (reference.doi) {
    const bare = reference.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');

    if (style.doiForm === 'url') return `https://doi.org/${bare}`;
    if (style.doiForm === 'prefixed') return `doi: ${bare}`;
    if (style.doiForm === 'bare') return bare;
    return '';
  }

  if (reference.url) return reference.url;
  return '';
}
