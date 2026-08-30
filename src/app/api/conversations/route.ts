import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { listRecent, startConversation } from '@/server/services/chat.service';

/**
 * The sidebar list, and starting a new thread.
 *
 * `mode` separates the agent workspace from the older per-project and per-tool
 * chats, which share the same tables. Without it the sidebar would show every
 * conversation the product has ever opened on the user's behalf, including ones
 * they never thought of as conversations.
 */
const listQuery = z.object({
  mode: z.enum(['CHAT', 'AGENT']).optional(),
  projectId: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});

export const GET = withApi({}, async ({ request, user }) => {
  const url = new URL(request.url);
  const query = listQuery.parse({
    mode: url.searchParams.get('mode') ?? undefined,
    projectId: url.searchParams.get('projectId') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });

  const conversations = await listRecent(user.id, {
    mode: query.mode ?? 'AGENT',
    projectId: query.projectId,
    limit: query.limit,
  });

  return ok({ conversations });
});

const createSchema = z.object({
  projectId: z.string().optional(),
  firstMessage: z.string().max(4000).optional(),
  mode: z.enum(['CHAT', 'AGENT']).optional(),
});

type CreateBody = z.infer<typeof createSchema>;

export const POST = withApi<CreateBody>(
  { schema: createSchema, rateLimit: { max: 60, windowSeconds: 300, key: 'conversations.create' } },
  async ({ user, body }) => {
    const conversation = await startConversation({
      userId: user.id,
      projectId: body.projectId ?? null,
      firstMessage: body.firstMessage,
      mode: body.mode ?? 'AGENT',
    });

    return ok({ conversation }, { status: 201 });
  },
);
