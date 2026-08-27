import { z } from 'zod';

import { CITATION_STYLES } from '@/config/research';
import { ok, withApi } from '@/server/http/api';
import { addReference, listReferences } from '@/server/services/reference.service';

const createSchema = z.object({
  rawText: z.string().trim().min(10).max(2000),
  style: z.enum(CITATION_STYLES).default('APA7'),
});

type Params = { id: string };
type Body = z.infer<typeof createSchema>;

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  const rows = await listReferences(params.id, user.id);
  return ok(rows);
});

export const POST = withApi<Body, Params>({ schema: createSchema }, async ({ user, params, body }) => {
  const reference = await addReference({
    projectId: params.id,
    userId: user.id,
    rawText: body.rawText,
    style: body.style,
  });
  return ok(reference, { status: 201 });
});
