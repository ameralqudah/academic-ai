import { ok, withApi } from '@/server/http/api';
import { MEMORY_WRITE_LIMIT, MEMORY_WRITE_USER_LIMIT, memoriesFlagged } from '@/server/memory/http';
import { confirmMemoryIn } from '@/server/memory/service';

type Params = { projectId: string; memoryId: string };

/** Confirms a proposal (or restores an archived memory). The only way a proposal becomes confirmed: a person, here. */
export const POST = memoriesFlagged(
  withApi<undefined, Params>({ rateLimit: MEMORY_WRITE_LIMIT, userRateLimit: MEMORY_WRITE_USER_LIMIT }, async ({ user, params }) =>
    ok({ memory: await confirmMemoryIn({ scope: 'project', projectId: params.projectId }, user.id, params.memoryId) }),
  ),
);
