import { z } from 'zod';

import { isSectionKey } from '@/config/research';
import { ok, withApi } from '@/server/http/api';
import { AppError } from '@/server/http/errors';
import { approveSection, getSection, saveSection } from '@/server/services/section.service';
import { updateSectionSchema } from '@/server/validation/project';

type Params = { id: string; key: string };
type Body = z.infer<typeof updateSectionSchema>;

function sectionKeyOf(params: Params) {
  if (!isSectionKey(params.key)) throw AppError.notFound('section');
  return params.key;
}

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  const section = await getSection(params.id, user.id, sectionKeyOf(params));
  return ok(section);
});

export const PATCH = withApi<Body, Params>(
  { schema: updateSectionSchema },
  async ({ user, params, body }) => {
    const section = await saveSection({
      projectId: params.id,
      userId: user.id,
      sectionKey: sectionKeyOf(params),
      content: body.content,
      heading: body.heading,
      status: body.status,
      origin: body.origin,
    });
    return ok(section);
  },
);

/** Approving is a distinct action: it is the researcher taking responsibility. */
export const POST = withApi<undefined, Params>({}, async ({ user, params }) => {
  const section = await approveSection(params.id, user.id, sectionKeyOf(params));
  return ok(section);
});
