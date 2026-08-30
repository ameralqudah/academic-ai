import { defineRouting } from 'next-intl/routing';

export const locales = ['ar', 'en'] as const;
export type Locale = (typeof locales)[number];

export const routing = defineRouting({
  locales,
  /**
   * English is the default; Arabic is fully supported alongside it.
   *
   * "Default" here means the locale chosen for someone who has expressed no
   * preference — an unprefixed path, or a first visit. It does not mean the
   * other locale is deprecated: `/ar/...` resolves exactly as it always has,
   * and a user who picks Arabic keeps it through the `NEXT_LOCALE` cookie that
   * the switcher sets.
   *
   * The alternative reading — redirecting `/ar/...` to `/en/...` — would make
   * English the default by making Arabic unreachable, which is a different and
   * much worse change.
   */
  defaultLocale: 'en',
  /*
   * The prefix stays on both locales rather than being hidden for the default.
   * Hiding it would make `/chat` and `/en/chat` two URLs for one page, which
   * splits analytics, confuses caches, and makes every canonical link a
   * decision. One shape per page is worth two extra characters.
   */
  localePrefix: 'always',
});

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
