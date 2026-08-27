import { withApi } from '@/server/http/api';
import { streamChat } from '@/server/services/ai.service';
import { chatSchema, type ChatInput } from '@/server/validation/ai';

export const maxDuration = 60;

/**
 * Streams Server-Sent Events. `withApi` still runs the guard chain first, so an
 * over-quota or unauthorised request returns a normal JSON error rather than an
 * empty stream.
 */
export const POST = withApi<ChatInput>(
  {
    schema: chatSchema,
    rateLimit: { key: 'ai-chat', max: 60, windowSeconds: 300 },
  },
  async ({ user, body }) => {
    const { stream, conversationId } = await streamChat(
      user.id,
      body.projectId,
      body.message,
      body.sectionKey,
    );

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-conversation-id': conversationId,
      },
    });
  },
);
