import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import {
  deleteConversation,
  prepareRegeneration,
  editMessage,
  getThread,
  renameConversation,
  switchToBranch,
} from '@/server/services/chat.service';

type Params = { id: string };

/** The thread as the user sees it: the active path, plus where it forks. */
export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  return ok(await getThread(params.id, user.id));
});

/**
 * Renaming, editing a message, or switching branch.
 *
 * One route because all three change what a conversation currently is, and
 * splitting them would mean three near-identical ownership checks. The action
 * is explicit in the body rather than inferred from which fields are present —
 * inference here would make a typo in a field name silently perform a different
 * operation.
 */
const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), title: z.string().min(1).max(200) }),
  z.object({
    action: z.literal('editMessage'),
    messageId: z.string(),
    content: z.string().min(1).max(8000),
  }),
  z.object({ action: z.literal('switchBranch'), messageId: z.string() }),
  /*
   * Regeneration takes the answer off the active path and returns the question
   * it replied to, ready to be asked again. The old answer stays as an inactive
   * branch — a user who preferred it can go back, which is why this is not a
   * deletion.
   */
  z.object({ action: z.literal('regenerate'), messageId: z.string() }),
]);

type PatchBody = z.infer<typeof patchSchema>;

export const PATCH = withApi<PatchBody, Params>(
  { schema: patchSchema },
  async ({ user, params, body }) => {
    switch (body.action) {
      case 'rename':
        return ok({ conversation: await renameConversation(params.id, user.id, body.title) });

      case 'editMessage': {
        const message = await editMessage({
          conversationId: params.id,
          userId: user.id,
          messageId: body.messageId,
          content: body.content,
        });
        return ok({ message, thread: await getThread(params.id, user.id) });
      }

      case 'switchBranch':
        return ok(await switchToBranch(params.id, user.id, body.messageId));

      case 'regenerate': {
        const prepared = await prepareRegeneration({
          conversationId: params.id,
          userId: user.id,
          messageId: body.messageId,
        });

        /*
         * The prompt is returned rather than the answer. Producing a new reply
         * means running the agent, which streams — and a JSON route cannot
         * stream. The client takes this and sends it back through /api/agent,
         * so regeneration goes down exactly the same path as an ordinary
         * message and cannot drift from it.
         */
        return ok({ prompt: prepared.prompt, thread: await getThread(params.id, user.id) });
      }
    }
  },
);

/**
 * Archives by default; `permanent=true` destroys.
 *
 * Two levels for the same reason datasets have them: an accidental click should
 * be recoverable, and a deliberate purge should be possible. The default is the
 * safe one.
 */
const deleteQuery = z.object({ permanent: z.enum(['true', 'false']).default('false') });

export const DELETE = withApi<undefined, Params>({}, async ({ request, user, params }) => {
  const url = new URL(request.url);
  const query = deleteQuery.parse({ permanent: url.searchParams.get('permanent') ?? 'false' });

  await deleteConversation(params.id, user.id, query.permanent === 'true');
  return ok({ deleted: true, permanent: query.permanent === 'true' });
});
