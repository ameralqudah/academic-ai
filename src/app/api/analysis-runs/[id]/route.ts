import { z } from 'zod';

import { SECTION_KEYS } from '@/config/research';
import { ok, withApi } from '@/server/http/api';
import { attachRun, deleteRun, detachRun, getRun } from '@/server/services/statistics.service';

type Params = { id: string };

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  return ok(await getRun(params.id, user.id));
});

const attachSchema = z.object({
  projectId: z.string().nullable(),
  sectionKey: z.string().nullable(),
});

type Body = z.infer<typeof attachSchema>;

/**
 * Attaches a result to a section of a project, or detaches it.
 *
 * This is the deliberate act that separates a number the researcher was
 * exploring from one they intend to report — and the link that will let the
 * results chapter be written from their own figures instead of an empty table.
 */
export const PATCH = withApi<Body, Params>({ schema: attachSchema }, async ({ user, params, body }) => {
  if (!body.projectId || !body.sectionKey) {
    return ok(await detachRun(params.id, user.id));
  }

  const known = (SECTION_KEYS as readonly string[]).includes(body.sectionKey);
  if (!known) {
    return ok(await detachRun(params.id, user.id));
  }

  return ok(
    await attachRun({
      runId: params.id,
      userId: user.id,
      projectId: body.projectId,
      sectionKey: body.sectionKey,
    }),
  );
});

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await deleteRun(params.id, user.id);
  return ok({ deleted: true });
});
