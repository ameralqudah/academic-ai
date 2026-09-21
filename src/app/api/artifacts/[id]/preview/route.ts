import { ok, withApi } from '@/server/http/api';
import { previewOf } from '@/server/services/artifact.service';

type Params = { id: string };

/** What the side panel needs to show one document without downloading it. */
export const GET = withApi<undefined, Params>(
  { rateLimit: { max: 200, windowSeconds: 300, key: 'artifact.preview' } },
  async ({ user, params }) => ok(await previewOf(params.id, user.id)),
);
