/**
 * Deep research as a background job.
 *
 * Fifteen searches, eight page fetches and four model calls take minutes. An
 * HTTP request will not survive that, so the request records a job and returns
 * its id, and the workflow continues while the client polls — the same
 * arrangement bootstrapping uses, on the same table.
 *
 * Reusing `analysis_jobs` rather than adding a table: `kind` is free text, the
 * columns needed are the ones already there (status, progress, stage, result),
 * and the stale-job cleanup that protects a bootstrap from a redeploy protects
 * this too. A second table would duplicate all of that to store the same shape.
 */

import { logger } from '@/lib/logger';
import type { AnalysisJob } from '@/server/db/schema';
import { AppError } from '@/server/http/errors';
import { resolveReason } from '@/server/http/reasons';
import * as jobsRepo from '@/server/repositories/analysis-jobs.repository';
import {
  runDeepResearch,
  ResearchCancelled,
  type DeepResearchReport,
} from '@/server/research/pipeline';
import { isWebSearchConfigured } from '@/server/services/web-search.service';

/** More than this in flight and a user is queueing work nobody will read. */
const MAX_CONCURRENT = 1;

export async function startDeepResearch(input: {
  userId: string;
  question: string;
  locale: 'ar' | 'en';
  projectId?: string | null;
}): Promise<AnalysisJob> {
  if (!isWebSearchConfigured()) {
    /*
     * Deep research without web search is a literature search under another
     * name. Refusing is more honest than running a degraded version and calling
     * it the same thing.
     */
    throw new AppError(
      'VALIDATION',
      'Deep research needs a web search provider, which is not configured.',
      'البحث المعمّق يحتاج مزوّد بحث ويب غير مهيّأ حاليًا.',
      { reasonKey: 'knowledge.error.notConfigured' },
    );
  }

  if ((await jobsRepo.countActive(input.userId)) >= MAX_CONCURRENT) {
    throw new AppError(
      'VALIDATION',
      'You already have research running. Wait for it to finish.',
      'لديك بحث قيد التنفيذ. انتظر انتهاءه.',
    );
  }

  const job = await jobsRepo.create({
    userId: input.userId,
    projectId: input.projectId ?? null,
    kind: 'research.deep',
    status: 'QUEUED',
    spec: { question: input.question, locale: input.locale },
  });

  /*
   * Started without being awaited, so the response reaches the client while the
   * work continues. The rejection handler is not optional: an unhandled
   * rejection from a floating promise takes down the process in Node.
   */
  void runResearchJob(job.id).catch((error: unknown) => {
    logger.error('deepResearch.jobCrashed', { jobId: job.id, error: String(error) });
  });

  return job;
}

/**
 * Executes a queued research job.
 *
 * Exported so a real worker process can drive it later without this file
 * changing — moving the work off the web process becomes a question of who
 * calls this, not of rewriting it.
 */
export async function runResearchJob(jobId: string): Promise<void> {
  const startedAt = Date.now();
  const job = await jobsRepo.findOwnedAny(jobId);

  if (!job || job.status !== 'QUEUED') return;

  await jobsRepo.markRunning(jobId);

  try {
    const spec = job.spec as { question: string; locale: 'ar' | 'en' };

    let cancelled = false;
    let lastCheck = 0;

    const report = await runDeepResearch({
      userId: job.userId,
      question: spec.question,
      locale: spec.locale,
      onProgress: (progress) => {
        void jobsRepo
          .updateProgress(jobId, progress.percent, progress.stage)
          .catch(() => undefined);
      },
      shouldStop: () => {
        /*
         * Polled rather than read every time: the check is a database round
         * trip, and the stages are seconds apart. Two seconds is fast enough
         * that a cancellation feels immediate and slow enough not to add load.
         */
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

    await jobsRepo.complete(
      jobId,
      { research: report as unknown as Record<string, unknown> },
      Date.now() - startedAt,
    );
  } catch (error) {
    if (error instanceof ResearchCancelled) {
      logger.info('deepResearch.cancelled', { jobId });
      return;
    }

    logger.error('deepResearch.failed', { jobId, error: String(error) });
    await jobsRepo.fail(jobId, 'analysis.job.error.failed', Date.now() - startedAt);
  }
}

export interface ResearchJobView {
  id: string;
  status: AnalysisJob['status'];
  progress: number;
  stage: string | null;
  error: { en: string; ar: string } | null;
  result: { research: DeepResearchReport } | null;
  durationMs: number | null;
}

export async function getResearchJob(id: string, userId: string): Promise<ResearchJobView> {
  const job = await jobsRepo.findOwned(id, userId);

  if (!job) {
    throw new AppError('NOT_FOUND', 'That research was not found.', 'لم يُعثر على البحث.');
  }

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    /* Resolved on the server, for the same reason upload errors are. */
    error: job.errorReasonKey ? resolveReason(job.errorReasonKey) : null,
    result: (job.result as { research: DeepResearchReport } | null) ?? null,
    durationMs: job.durationMs,
  };
}

export async function cancelResearch(id: string, userId: string): Promise<void> {
  const cancelled = await jobsRepo.cancel(id, userId);

  if (!cancelled) {
    throw new AppError(
      'VALIDATION',
      'That research has already finished.',
      'انتهى هذا البحث بالفعل.',
    );
  }
}
