import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import {
  deleteProject,
  getProjectWithSections,
  switchDocType,
  updateProject,
} from '@/server/services/project.service';
import { updateProjectSchema } from '@/server/validation/project';

type Params = { id: string };
type UpdateBody = z.infer<typeof updateProjectSchema>;

export const GET = withApi<undefined, Params>({}, async ({ user, params }) => {
  const result = await getProjectWithSections(params.id, user.id);
  return ok(result);
});

export const PATCH = withApi<UpdateBody, Params>(
  { schema: updateProjectSchema },
  async ({ user, params, body }) => {
    const { docType, ...rest } = body;

    // Changing the document type also creates the sections the new shape needs,
    // so it goes through its own service call rather than a plain column update.
    if (docType) await switchDocType(params.id, user.id, docType);

    const project = await updateProject(params.id, user.id, rest);
    return ok(project);
  },
);

export const DELETE = withApi<undefined, Params>({}, async ({ user, params }) => {
  await deleteProject(params.id, user.id);
  return ok({ deleted: true });
});
