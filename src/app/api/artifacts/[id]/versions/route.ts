import { ok, withApi } from '@/server/http/api';
import { versionsOf } from '@/server/services/artifact.service';

type Params = { id: string };

/**
 * Every version of a document.
 *
 * Takes any version's id, because that is what the caller has: a researcher
 * looking at version 2 wants the history without knowing what a lineage is.
 */
export const GET = withApi<undefined, Params>({}, async ({ user, params }) =>
  ok({ versions: await versionsOf(params.id, user.id) }),
);
