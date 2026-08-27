import { ok, withApi } from '@/server/http/api';
import { createProject, listProjects } from '@/server/services/project.service';
import { createProjectSchema, type CreateProjectInput } from '@/server/validation/project';

export const GET = withApi({}, async ({ user, request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '') || undefined;
  const projects = await listProjects(user.id, limit);
  return ok(projects);
});

export const POST = withApi<CreateProjectInput>(
  {
    schema: createProjectSchema,
    rateLimit: { key: 'project-create', max: 20, windowSeconds: 600 },
  },
  async ({ user, body }) => {
    const project = await createProject(user.id, body);
    return ok(project, { status: 201 });
  },
);
