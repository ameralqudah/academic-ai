import { z } from 'zod';

import { ok, withApi } from '@/server/http/api';
import { runPls, startBootstrap } from '@/server/services/pls.service';
import { ensureStaleJobsFailed } from '@/server/services/startup';

/**
 * PLS-SEM: estimate now, bootstrap in the background.
 *
 * The split is not a preference. Estimating the model takes milliseconds and
 * belongs in the request; bootstrapping it five thousand times takes a minute
 * and would time out. So this route answers with the model and its assessment,
 * and starting the resampling returns a job id to poll.
 */
const constructSchema = z.object({
  name: z.string().min(1).max(80),
  indicators: z.array(z.string()).min(1).max(30),
  mode: z.enum(['reflective', 'formative']),
});

const modelSchema = z.object({
  constructs: z.array(constructSchema).min(2).max(20),
  paths: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .min(1)
    .max(100),
});

const runSchema = z.object({
  datasetId: z.string(),
  model: modelSchema,
  /** When true, the estimate is returned and a bootstrap job is started. */
  bootstrap: z.boolean().default(false),
  resamples: z.number().min(1000).max(10_000).optional(),
  confidenceLevel: z.number().min(0.8).max(0.999).optional(),
  seed: z.number().optional(),
  projectId: z.string().optional(),
});

type Body = z.infer<typeof runSchema>;

export const POST = withApi<Body>(
  { schema: runSchema, rateLimit: { max: 20, windowSeconds: 300, key: 'pls.run' } },
  async ({ user, body }) => {
    /*
     * Clears jobs orphaned by a restart, once per process. Placed here rather
     * than in a startup hook because Next offers no dependable boot moment on
     * this platform — and this is the route where a stale job would be noticed.
     */
    await ensureStaleJobsFailed();

    const analysis = await runPls({
      datasetId: body.datasetId,
      userId: user.id,
      model: body.model,
    });

    if (!body.bootstrap) return ok({ analysis, job: null });

    const job = await startBootstrap({
      datasetId: body.datasetId,
      userId: user.id,
      projectId: body.projectId ?? null,
      model: body.model,
      resamples: body.resamples,
      confidenceLevel: body.confidenceLevel,
      seed: body.seed,
    });

    return ok(
      {
        analysis,
        /* Only what the client needs to poll — the result is not ready yet. */
        job: { id: job.id, status: job.status, progress: job.progress },
      },
      { status: 202 },
    );
  },
);
