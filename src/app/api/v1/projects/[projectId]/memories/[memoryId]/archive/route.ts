import { ok, withApi } from '@/server/http/api';
import { MEMORY_WRITE_LIMIT, MEMORY_WRITE_USER_LIMIT, memoriesFlagged } from '@/server/memory/http';
import { archiveMemoryIn } from '@/server/memory/service';

type Params = { projectId: string; memoryId: string };

/** Archives a memory: kept, but never used in context. */
export const POST = memoriesFlagged(
  withApi<undefined, Params>({ rateLimit: MEMORY_WRITE_LIMIT, userRateLimit: MEMORY_WRITE_USER_LIMIT }, async ({ user, params }) =>
    ok({ memory: await archiveMemoryIn({ scope: 'project', projectId: params.projectId }, user.id, params.memoryId) }),
  ),
);
