/**
 * Running a PLS-SEM analysis.
 *
 * Split in two, and the split follows the arithmetic rather than any
 * architectural preference. Estimating the model once takes milliseconds and
 * belongs in the request. Bootstrapping it five thousand times takes a minute
 * and cannot be: the request would be gone long before, and Render would return
 * a timeout while the work carried on invisibly.
 *
 * So `runPls` answers immediately with the model, its measurement quality and
 * its structural coefficients — everything except the significance of those
 * coefficients. `startBootstrap` records a job, returns its id, and continues
 * after the response has been sent.
 *
 * **The honest limitation, stated because it shapes what a user should expect.**
 * The background work runs inside the web process; there is no separate worker.
 * A redeploy in the middle of a bootstrap loses it, which is why stale jobs are
 * failed at startup rather than left showing a progress bar that never moves.
 * Moving to a real worker later changes where `runBootstrapJob` is called from
 * and nothing else.
 */

import {
  assessDiscriminantValidity,
  assessMeasurement,
  assessStructural,
  type ConstructAssessment,
  type DiscriminantValidity,
  type StructuralAssessment,
} from '@/analysis/inference/pls/assessment';
import {
  estimatePls,
  PlsError,
  validateModel,
  type PlsModel,
} from '@/analysis/inference/pls/algorithm';
import { bootstrapPls, type BootstrapResult } from '@/analysis/inference/pls/bootstrap';
import { logger } from '@/lib/logger';
import type { AnalysisJob } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { resolveReason } from '@/server/http/reasons';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import { loadForAnalysis } from '@/server/services/dataset.service';

/** More than this in flight and a user is queueing work nobody will read. */
const MAX_CONCURRENT_JOBS = 2;
/** Bootstrap resamples. Five thousand is the reporting convention. */
const DEFAULT_RESAMPLES = 5000;

export interface PlsAnalysis {
  model: PlsModel;
  measurement: ConstructAssessment[];
  discriminant: {
    htmt: { pair: string; value: number; verdict: string; explanationKey: string }[];
    fornellLarcker: DiscriminantValidity['fornellLarcker'];
    crossLoadingIssues: DiscriminantValidity['crossLoadingIssues'];
  };
  structural: StructuralAssessment;
  n: number;
  rowsDropped: number;
  iterations: number;
  converged: boolean;
}

/* -------------------------------------------------------------------------- */
/*                              Estimation                                    */
/* -------------------------------------------------------------------------- */

/**
 * Estimates the model and assesses it — fast enough to run inline.
 *
 * Everything here is deterministic: the same data and model give the same
 * numbers every time, with no resampling involved. What it cannot give is a
 * p-value for any path, which is what the bootstrap is for.
 */
export async function runPls(input: {
  datasetId: string;
  userId: string;
  model: PlsModel;
}): Promise<PlsAnalysis> {
  const loaded = await loadForAnalysis(input.datasetId, input.userId);

  const columns = new Map<string, number[]>();
  for (const name of loaded.data.columns) {
    const index = loaded.data.columns.indexOf(name);
    columns.set(
      name,
      loaded.data.rows.map((row) => {
        const value = row[index];
        const parsed = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(parsed) ? parsed : Number.NaN;
      }),
    );
  }

  try {
    validateModel(input.model, [...columns.keys()]);
    const estimate = estimatePls(input.model, columns);

    const measurement = assessMeasurement(input.model, estimate, columns);
    const discriminant = assessDiscriminantValidity(input.model, estimate, columns, measurement);
    const structural = assessStructural(input.model, estimate);

    logger.info('pls.estimated', {
      datasetId: input.datasetId,
      constructs: input.model.constructs.length,
      paths: input.model.paths.length,
      n: estimate.n,
      iterations: estimate.iterations,
    });

    return {
      model: input.model,
      measurement,
      discriminant: {
        /* A Map does not survive JSON, so the pairs are flattened for transport. */
        htmt: [...discriminant.htmt.entries()].map(([pair, criterion]) => ({
          pair,
          value: criterion.value,
          verdict: criterion.verdict,
          explanationKey: criterion.explanationKey,
        })),
        fornellLarcker: discriminant.fornellLarcker,
        crossLoadingIssues: discriminant.crossLoadingIssues,
      },
      structural,
      n: estimate.n,
      rowsDropped: estimate.rowsDropped,
      iterations: estimate.iterations,
      converged: estimate.converged,
    };
  } catch (error) {
    throw asAppError(error);
  }
}

/* -------------------------------------------------------------------------- */
/*                              Bootstrapping                                 */
/* -------------------------------------------------------------------------- */

/**
 * Records a bootstrap job and starts it.
 *
 * Returns as soon as the row exists. The work is kicked off without being
 * awaited, so the response reaches the client while the resampling continues —
 * which is the whole arrangement, and also why the promise carries a rejection
 * handler: an unhandled rejection from a floating promise takes down the
 * process in Node.
 */
export async function startBootstrap(input: {
  datasetId: string;
  userId: string;
  projectId?: string | null;
  model: PlsModel;
  resamples?: number;
  confidenceLevel?: number;
  seed?: number;
}): Promise<AnalysisJob> {
  if ((await jobsRepo.countActive(input.userId)) >= MAX_CONCURRENT_JOBS) {
    throw new AppError(
      'VALIDATION',
      `You already have ${MAX_CONCURRENT_JOBS} analyses running. Wait for one to finish.`,
      `لديك ${MAX_CONCURRENT_JOBS} تحليلات قيد التنفيذ. انتظر انتهاء أحدها.`,
    );
  }

  /*
   * The model is validated before the job is created. A specification error
   * discovered a minute into a background run is a minute the user waited to be
   * told something that was knowable immediately.
   */
  const loaded = await loadForAnalysis(input.datasetId, input.userId);
  try {
    validateModel(input.model, loaded.data.columns);
  } catch (error) {
    throw asAppError(error);
  }

  const resamples = clampResamples(input.resamples);

  const job = await jobsRepo.create({
    userId: input.userId,
    datasetId: input.datasetId,
    projectId: input.projectId ?? null,
    kind: 'pls.bootstrap',
    status: 'QUEUED',
    spec: {
      model: input.model as unknown as Record<string, unknown>,
      resamples,
      confidenceLevel: input.confidenceLevel ?? 0.95,
      seed: input.seed ?? 20260101,
    },
  });

  void runBootstrapJob(job.id).catch((error: unknown) => {
    logger.error('pls.bootstrapJobCrashed', { jobId: job.id, error: String(error) });
  });

  return job;
}

/**
 * Executes a queued bootstrap.
 *
 * Exported so a real worker process can call it later without this file
 * changing — moving the work off the web process is then a matter of who
 * invokes this, not of rewriting it.
 */
export async function runBootstrapJob(jobId: string): Promise<void> {
  const startedAt = Date.now();

  const [job] = await Promise.all([jobsRepo.findOwnedAny(jobId)]);
  if (!job || job.status !== 'QUEUED') return;

  await jobsRepo.markRunning(jobId);

  try {
    const spec = job.spec as {
      model: PlsModel;
      resamples: number;
      confidenceLevel: number;
      seed: number;
    };

    const loaded = await loadForAnalysis(job.datasetId as string, job.userId);

    const columns = new Map<string, number[]>();
    for (const name of loaded.data.columns) {
      const index = loaded.data.columns.indexOf(name);
      columns.set(
        name,
        loaded.data.rows.map((row) => {
          const value = row[index];
          const parsed = typeof value === 'number' ? value : Number(value);
          return Number.isFinite(parsed) ? parsed : Number.NaN;
        }),
      );
    }

    await jobsRepo.updateProgress(jobId, 0, 'estimating');
    const estimate = estimatePls(spec.model, columns);

    /*
     * Cancellation is checked between resamples rather than after them all. A
     * user who starts a five-thousand-resample run and changes their mind
     * should not wait a minute for the stop to take effect.
     *
     * The check is a database read, so it is throttled: once per percent, not
     * once per resample.
     */
    let cancelled = false;
    let lastCheck = 0;

    const result = bootstrapPls(spec.model, columns, estimate, {
      resamples: spec.resamples,
      confidenceLevel: spec.confidenceLevel,
      seed: spec.seed,
      onProgress: (percent) => {
        void jobsRepo.updateProgress(jobId, percent, 'resampling').catch(() => undefined);
      },
      shouldStop: () => {
        const now = Date.now();
        if (now - lastCheck > 2000) {
          lastCheck = now;
          void jobsRepo.isCancelled(jobId).then((value) => {
            cancelled = value;
          });
        }
        return cancelled;
      },
    });

    if (cancelled) {
      logger.info('pls.bootstrapCancelled', { jobId });
      return;
    }

    await jobsRepo.updateProgress(jobId, 100, 'summarising');

    await jobsRepo.complete(
      jobId,
      { bootstrap: result as unknown as Record<string, unknown> },
      Date.now() - startedAt,
    );

    logger.info('pls.bootstrapCompleted', {
      jobId,
      resamples: result.resamples,
      failed: result.failed,
      ms: result.durationMs,
    });
  } catch (error) {
    const reasonKey =
      error instanceof PlsError ? error.reasonKey : 'analysis.job.error.failed';

    logger.error('pls.bootstrapFailed', { jobId, reason: reasonKey, error: String(error) });
    await jobsRepo.fail(jobId, reasonKey, Date.now() - startedAt);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Reading                                   */
/* -------------------------------------------------------------------------- */

export interface JobView {
  id: string;
  status: AnalysisJob['status'];
  progress: number;
  stage: string | null;
  /** Resolved to a sentence on the server, in both languages. */
  error: { en: string; ar: string } | null;
  result: { bootstrap: BootstrapResult } | null;
  durationMs: number | null;
  createdAt: string;
}

export async function getJob(id: string, userId: string): Promise<JobView> {
  const job = await jobsRepo.findOwned(id, userId);

  if (!job) {
    throw new AppError('NOT_FOUND', 'That analysis was not found.', 'لم يُعثر على التحليل.');
  }

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    /*
     * Resolved here rather than in the browser, for the same reason upload
     * errors are: a key looked up on the client fails silently and shows the
     * key itself to the user.
     */
    error: job.errorReasonKey ? resolveReason(job.errorReasonKey) : null,
    result: (job.result as { bootstrap: BootstrapResult } | null) ?? null,
    durationMs: job.durationMs,
    createdAt: job.createdAt.toISOString(),
  };
}

export async function cancelJob(id: string, userId: string): Promise<void> {
  const cancelled = await jobsRepo.cancel(id, userId);

  if (!cancelled) {
    throw new AppError(
      'VALIDATION',
      'That analysis has already finished.',
      'انتهى هذا التحليل بالفعل.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Support                                   */
/* -------------------------------------------------------------------------- */

/**
 * Keeps the resample count within what is both meaningful and affordable.
 *
 * Below a thousand the percentile intervals move visibly between runs, which
 * makes them unfit to report. Above ten thousand the extra precision is beyond
 * what three decimals show, and the time is the user's.
 */
function clampResamples(requested?: number): number {
  if (!requested || !Number.isFinite(requested)) return DEFAULT_RESAMPLES;
  return Math.max(1000, Math.min(10_000, Math.round(requested)));
}

/** A specification error becomes a message the researcher can act on. */
function asAppError(error: unknown): unknown {
  if (error instanceof PlsError) {
    const message = resolveReason(error.reasonKey, error.params);
    return new AppError('VALIDATION', message.en, message.ar, {
      reasonKey: error.reasonKey,
      params: error.params,
    });
  }
  return error;
}
