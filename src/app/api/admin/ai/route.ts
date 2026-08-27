import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { aiUsage, getAISettings, setAISettings } from '@/server/services/admin.service';

const patchSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google']),
  models: z.record(z.string(), z.string().max(80)).optional(),
});

type PatchBody = z.infer<typeof patchSchema>;

export const GET = withApi({ admin: true }, async () => {
  const [usage, settings] = await Promise.all([aiUsage(), getAISettings()]);
  return ok({ ...usage, settings });
});

export const PATCH = withApi<PatchBody>({ admin: true, schema: patchSchema }, async ({ body }) => {
  await setAISettings(body);
  return ok({ updated: true });
});
