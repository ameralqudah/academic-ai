import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { listPlans, updatePlan } from '@/server/services/admin.service';

const patchSchema = z.object({
  planId: z.string().min(1),
  priceCents: z.number().int().min(0).max(1_000_000).optional(),
  maxProjects: z.number().int().min(-1).max(10_000).optional(),
  maxAiRequests: z.number().int().min(-1).max(1_000_000).optional(),
  maxGeneratedWords: z.number().int().min(-1).max(100_000_000).optional(),
  maxExports: z.number().int().min(-1).max(100_000).optional(),
  toolAccess: z.record(z.string(), z.boolean()).optional(),
  isActive: z.boolean().optional(),
  externalPriceId: z.string().max(120).nullable().optional(),
});

type PatchBody = z.infer<typeof patchSchema>;

export const GET = withApi({ admin: true }, async () => ok(await listPlans()));

export const PATCH = withApi<PatchBody>({ admin: true, schema: patchSchema }, async ({ body }) => {
  const { planId, ...values } = body;
  await updatePlan(planId, values);
  return ok({ updated: true });
});
