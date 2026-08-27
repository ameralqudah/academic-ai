/**
 * Text helpers that have to behave the same in Arabic and English.
 *
 * `countWords` powers both the editor counter and billing, so it must not treat
 * Arabic diacritics or the tatweel as word boundaries.
 */

const WORD_SEPARATORS = /[\s،؛؟٫٬.,;:!?()[\]{}"'«»—–\-/\\]+/u;
const ARABIC_DIACRITICS = /[ً-ْـ]/gu;

export function countWords(input: string): number {
  if (!input) return 0;
  const normalized = input.replace(ARABIC_DIACRITICS, '').trim();
  if (!normalized) return 0;
  return normalized.split(WORD_SEPARATORS).filter(Boolean).length;
}

export function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1).trimEnd()}…`;
}

export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}

/** A stable, readable slug for both scripts (Arabic characters are preserved). */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
