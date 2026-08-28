import { withApi } from '@/server/http/api';
import { downloadOwned } from '@/server/services/dataset.service';

/**
 * Streams the stored file back to its owner.
 *
 * Deliberately routed through the application rather than served from a signed
 * storage URL. A signed URL is easier and it moves the authorisation to a
 * token: anyone holding the link holds the file, for as long as the link lives.
 * Going through the app means the ownership check runs on every single request,
 * which is the property worth paying a little latency for when the files are
 * other people's research data.
 */
export const GET = withApi<undefined, { id: string }>(
  { rateLimit: { max: 30, windowSeconds: 300, key: 'datasets.download' } },
  async ({ user, params }) => {
    const { filename, csv } = await downloadOwned(params.id, user.id);

    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        // Never cached by a proxy: the response is one user's private data.
        'cache-control': 'private, no-store',
      },
    });
  },
);
