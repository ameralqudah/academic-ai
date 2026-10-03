import type { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { editMemorySchema, MEMORY_BODY_BYTES, MEMORY_WRITE_LIMIT, MEMORY_WRITE_USER_LIMIT, memoriesFlagged } from '@/server/memory/http';
import { deleteMemoryIn, editMemoryIn } from '@/server/memory/service';

type Params = { projectId: string; memoryId: string };

/** Edits a memory's content, kind or pin (never its status, scope or owner). */
export const PATCH = memoriesFlagged(
  withApi<z.infer<typeof editMemorySchema>, Params>(
    { schema: editMemorySchema, rateLimit: MEMORY_WRITE_LIMIT, userRateLimit: MEMORY_WRITE_USER_LIMIT, maxBodyBytes: MEMORY_BODY_BYTES },
    async ({ user, params, body }) => ok({ memory: await editMemoryIn({ scope: 'project', projectId: params.projectId }, user.id, params.memoryId, body) }),
  ),
);

export const DELETE = memoriesFlagged(
  withApi<undefined, Params>({ rateLimit: MEMORY_WRITE_LIMIT, userRateLimit: MEMORY_WRITE_USER_LIMIT }, async ({ user, params }) => {
    await deleteMemoryIn({ scope: 'project', projectId: params.projectId }, user.id, params.memoryId);
    return ok({ deleted: true });
  }),
);
