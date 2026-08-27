import createMiddleware from 'next-intl/middleware';

import { routing } from '@/i18n/routing';

/**
 * Locale resolution only (Next 16 renamed this convention from `middleware` to
 * `proxy`). Route protection lives in the server layouts — `(app)/layout.tsx`
 * and `(app)/admin/layout.tsx` — and in `withApi` for API routes, where the full
 * session, including the user's role, is available.
 */
export default createMiddleware(routing);

export const config = {
  matcher: [
    // Everything except API routes, Next internals and static files.
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
};
