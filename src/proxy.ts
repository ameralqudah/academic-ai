import { NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';

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
 *
 * The browser's `Accept-Language` is deliberately kept from the locale
 * negotiation. It is a guess about a person, not a choice they made, and left
 * in place it sent every Arabic-language browser to `/ar` — so the "default"
 * above applied to almost nobody it was meant for. `localeDetection: false`
 * would also do that, but it throws away the `NEXT_LOCALE` cookie with it, and
 * the cookie *is* a choice: someone who picked Arabic should get Arabic back
 * when they open the bare domain. Dropping the one header keeps the two apart.
 */
const negotiate = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  if (!request.headers.has('accept-language')) return negotiate(request);

  const headers = new Headers(request.headers);
  headers.delete('accept-language');
  return negotiate(new NextRequest(request, { headers }));
}

export const config = {
  matcher: [
    // Everything except API routes, Next internals and static files.
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
};
