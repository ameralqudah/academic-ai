import type { SectionKey } from '@/config/research';

/**
 * `LITERATURE_REVIEW` → `literatureReview`, `CHAPTER_1` → `chapter1`.
 * Keeps section keys and translation keys in sync without a lookup table that
 * has to be updated twice whenever a section is added.
 */
export function sectionI18nKey(key: SectionKey | string): string {
  return key
    .toLowerCase()
    .split('_')
    .map((part, index) =>
      index === 0 || /^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}
