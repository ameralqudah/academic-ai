import type { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { createMemorySchema, MEMORY_BODY_BYTES, MEMORY_READ_LIMIT, MEMORY_READ_USER_LIMIT, MEMORY_WRITE_LIMIT, MEMORY_WRITE_USER_LIMIT, memoriesFlagged, statusFilter } from '@/server/memory/http';
import { createMemoryIn, listMemoriesIn } from '@/server/memory/service';

type Params = { projectId: string; };

/** The project memories (`?status=proposed|confirmed|archived`). P1-E; behind FF_CONTEXT_V2. */
export const GET = memoriesFlagged(
  withApi<undefined, Params>({ rateLimit: MEMORY_READ_LIMIT, userRateLimit: MEMORY_READ_USER_LIMIT }, async ({ user, params, request }) =>
    ok(await listMemoriesIn({ scope: 'project', projectId: params.projectId }, user.id, statusFilter(request))),
  ),
);

/** Adds a memory, as the signed-in user: source `user`, confirmed. Needs EDITOR. */
export const POST = memoriesFlagged(
  withApi<z.infer<typeof createMemorySchema>, Params>(
    { schema: createMemorySchema, rateLimit: MEMORY_WRITE_LIMIT, userRateLimit: MEMORY_WRITE_USER_LIMIT, maxBodyBytes: MEMORY_BODY_BYTES },
    async ({ user, params, body }) => ok({ memory: await createMemoryIn({ scope: 'project', projectId: params.projectId }, user.id, body) }, { status: 201 }),
  ),
);
