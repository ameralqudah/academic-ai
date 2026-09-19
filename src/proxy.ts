import createMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';

import { routing } from '@/i18n/routing';

/**
 * Locale resolution only (Next 16 renamed this convention from `middleware` to
 * `proxy`). Route protection lives in the server layouts — `(app)/layout.tsx`
 * and `(app)/admin/layout.tsx` — and in `withApi` for API routes, where the full
 * session, including the user's role, is available.
 *
 * This is where the English default takes effect. A path with no locale gets
 * one from `routing.defaultLocale`, which is now `en`; a path that already says
 * `ar` keeps it and is not rewritten.
 *
 * That second half is the important one. Redirecting `/ar/...` to `/en/...`
 * would make English the default by making Arabic unreachable — the locale
 * switcher would have nowhere to send anyone, and a user who set Arabic as
 * their preference would be overruled on every navigation. A default decides
 * for people who have not chosen; it does not overrule people who have.
 */
const resolveLocale = createMiddleware(routing);

/**
 * next-intl decides the locale in four steps: the path prefix, then the
 * `NEXT_LOCALE` cookie, then the `accept-language` header, then the default.
 * We want the first two and the last, but not the third — an `accept-language`
 * header is what a browser was configured with, which is a guess about a
 * person rather than a choice they made. A researcher browsing from Amman with
 * an Arabic-configured browser was being sent to `/ar` and never saw the
 * English default the two comments above describe.
 *
 * The header is dropped rather than `localeDetection` being switched off,
 * because that flag turns off the cookie too, and the cookie is the whole
 * mechanism by which the switcher makes a choice stick.
 */
export default function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete('accept-language');
  return resolveLocale(new NextRequest(request, { headers }));
}

export const config = {
  matcher: [
    // Everything except API routes, Next internals and static files.
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
};
