/**
 * References in the formats a reference manager reads.
 *
 * A researcher who has collected sixty sources here should be able to move them
 * into Zotero, Mendeley or EndNote rather than retyping them. BibTeX and RIS
 * are what those tools import, and between them they cover every manager in
 * use.
 *
 * **Neither format is forgiving of malformed input.** An unescaped brace ends a
 * BibTeX entry early and takes the rest of the file with it; a RIS line without
 * its two-letter tag is silently dropped. Both are handled below rather than
 * assumed away, because a bibliography that imports with eleven of sixty
 * entries is worse than one that fails outright — the researcher does not
 * notice the missing forty-nine.
 */

import type { Reference, SourceKind } from '@/server/quality/sources';

/* -------------------------------------------------------------------------- */
/*                                   BibTeX                                   */
/* -------------------------------------------------------------------------- */

/** BibTeX entry types, by source kind. */
const BIBTEX_TYPE: Record<SourceKind, string> = {
  'journal-article': 'article',
  book: 'book',
  'book-chapter': 'incollection',
  'conference-paper': 'inproceedings',
  report: 'techreport',
  thesis: 'phdthesis',
  website: 'misc',
  dataset: 'misc',
  preprint: 'misc',
  unknown: 'misc',
};

export function toBibTeX(references: Reference[]): string {
  const usedKeys = new Set<string>();

  return references
    .map((reference) => {
      const key = uniqueKey(reference, usedKeys);
      const type = BIBTEX_TYPE[reference.kind] ?? 'misc';
      const fields: string[] = [];

      const push = (name: string, value: string | number | undefined) => {
        if (value === undefined || value === null || String(value).trim() === '') return;
        fields.push(`  ${name} = {${escapeBibTeX(String(value))}}`);
      };

      push('title', reference.title);

      if (reference.authors && reference.authors.length > 0) {
        /* BibTeX joins authors with " and ", not commas — commas separate name parts. */
        push('author', reference.authors.map((author) => author.trim()).join(' and '));
      }

      push('year', reference.year);

      /*
       * The container field differs by entry type, and using the wrong one
       * makes the reference render without its journal or proceedings name.
       */
      if (type === 'article') push('journal', reference.container);
      else if (type === 'inproceedings') push('booktitle', reference.container);
      else if (type === 'incollection') push('booktitle', reference.container);

      push('publisher', reference.publisher);
      push('volume', reference.volume);
      push('number', reference.issue);
      push('pages', reference.pages);
      push('doi', reference.doi);
      push('isbn', reference.isbn);
      push('url', reference.url);

      if (type === 'phdthesis') push('school', reference.publisher);
      if (type === 'techreport') push('institution', reference.publisher);

      return `@${type}{${key},\n${fields.join(',\n')}\n}`;
    })
    .join('\n\n');
}

/**
 * A citation key that is unique within the file.
 *
 * Two papers by the same author in the same year would otherwise share a key,
 * and BibTeX silently keeps only one — losing a reference without saying so.
 */
function uniqueKey(reference: Reference, used: Set<string>): string {
  const surname = (reference.authors?.[0] ?? 'anon')
    .split(',')[0]
    ?.trim()
    .replace(/[^\p{L}]/gu, '')
    .toLowerCase()
    .slice(0, 20) || 'anon';

  const base = `${surname}${reference.year ?? ''}`;

  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (const suffix of 'abcdefghijklmnopqrstuvwxyz') {
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  const fallback = `${base}${used.size}`;
  used.add(fallback);
  return fallback;
}

/**
 * Escapes what BibTeX treats as syntax.
 *
 * Unbalanced braces are the dangerous case: one in a title ends the entry early
 * and everything after it becomes garbage. The `%` starts a comment and `#`
 * concatenates.
 */
function escapeBibTeX(value: string): string {
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}%$&#_])/g, '\\$1')
    .replace(/[\n\r]+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/*                                     RIS                                    */
/* -------------------------------------------------------------------------- */

/** RIS reference types. */
const RIS_TYPE: Record<SourceKind, string> = {
  'journal-article': 'JOUR',
  book: 'BOOK',
  'book-chapter': 'CHAP',
  'conference-paper': 'CONF',
  report: 'RPRT',
  thesis: 'THES',
  website: 'ELEC',
  dataset: 'DATA',
  preprint: 'UNPB',
  unknown: 'GEN',
};

export function toRIS(references: Reference[]): string {
  return references
    .map((reference) => {
      const lines: string[] = [`TY  - ${RIS_TYPE[reference.kind] ?? 'GEN'}`];

      const push = (tag: string, value: string | number | undefined) => {
        if (value === undefined || value === null || String(value).trim() === '') return;
        /* A newline inside a value breaks the tag structure of every line after it. */
        lines.push(`${tag}  - ${String(value).replace(/[\n\r]+/g, ' ').trim()}`);
      };

      /* One AU line per author: RIS repeats the tag rather than joining. */
      for (const author of reference.authors ?? []) push('AU', author);

      push('TI', reference.title);
      push('PY', reference.year);
      push('JO', reference.container);
      push('PB', reference.publisher);
      push('VL', reference.volume);
      push('IS', reference.issue);

      /*
       * Pages split into start and end. A single `SP - 412-435` imports as a
       * start page of "412-435", which then sorts and displays wrongly.
       */
      if (reference.pages) {
        const [start, end] = reference.pages.split(/\s*[-–]\s*/);
        push('SP', start);
        if (end) push('EP', end);
      }

      push('DO', reference.doi);
      push('SN', reference.isbn);
      push('UR', reference.url);

      /* ER terminates the record; without it the next entry merges into this one. */
      lines.push('ER  - ');

      return lines.join('\n');
    })
    .join('\n\n');
}
