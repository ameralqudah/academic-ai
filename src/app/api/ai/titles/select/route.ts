import { ok, withApi } from '@/server/http/api';
import { selectTitle } from '@/server/services/ai.service';
import { selectTitleSchema, type SelectTitleInput } from '@/server/validation/ai';

export const POST = withApi<SelectTitleInput>(
  { schema: selectTitleSchema },
  async ({ user, body }) => {
    const result = await selectTitle(user.id, body.projectId, body.candidateId);
    return ok(result);
  },
);
