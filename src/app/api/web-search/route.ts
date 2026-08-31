import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { searchWeb } from '@/server/services/web-search.service';

/**
 * Web search, grounded in the pages it found.
 *
 * The Serper key stays here: this route calls the provider, and the browser
 * calls this route. A key in a client bundle is a key anyone can read from the
 * network tab.
 *
 * Rate-limited more tightly than chat because each request costs a search
 * credit and up to five page fetches — a loop in a client would exhaust a
 * month's quota in minutes.
 */
const schema = z.object({
  query: z.string().min(3).max(500),
  locale: z.enum(['ar', 'en']).default('en'),
  /** Answer from snippets without fetching pages: faster and much shallower. */
  quick: z.boolean().default(false),
});

type Body = z.infer<typeof schema>;

export const POST = withApi<Body>(
  { schema, rateLimit: { max: 20, windowSeconds: 300, key: 'web.search' } },
  async ({ user, body }) => {
    const result = await searchWeb({
      userId: user.id,
      query: body.query,
      locale: body.locale,
      quick: body.quick,
    });

    return ok(result);
  },
);
