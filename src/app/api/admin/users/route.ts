import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { setUserRole, setUserStatus, users } from '@/server/services/admin.service';

const patchSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  role: z.enum(['USER', 'ADMIN']).optional(),
});

type PatchBody = z.infer<typeof patchSchema>;

export const GET = withApi({ admin: true }, async ({ request }) => {
  const url = new URL(request.url);
  const result = await users({
    search: url.searchParams.get('search') ?? undefined,
    page: Number(url.searchParams.get('page') ?? '1') || 1,
    pageSize: Number(url.searchParams.get('pageSize') ?? '25') || 25,
  });
  return ok(result);
});

export const PATCH = withApi<PatchBody>(
  { admin: true, schema: patchSchema },
  async ({ user, body }) => {
    if (body.status) await setUserStatus(user.id, body.userId, body.status);
    if (body.role) await setUserRole(user.id, body.userId, body.role);
    return ok({ updated: true });
  },
);
