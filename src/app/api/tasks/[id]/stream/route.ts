import { auth } from '@/server/auth';
import { openTaskStream } from '@/server/http/task-stream';

/** Live progress for one task: see `server/http/task-stream`. Sign-in is checked here, ownership and limits there. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();

  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = await context.params;
  return openTaskStream(request, session.user.id, id);
}
