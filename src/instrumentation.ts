/**
 * Runs once when the server starts (Next.js instrumentation hook).
 *
 * With `JOB_RUNNER=inline` — the default outside Vercel — the web process also
 * consumes the job queues, so a single-service deployment keeps working with
 * durable background jobs and no extra service. Node runtime only: pg-boss
 * needs TCP to PostgreSQL.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { jobRunner } = await import('@/server/jobs/mode');
  if (jobRunner() !== 'inline') return;

  const { startJobWorkers } = await import('@/server/jobs/worker');
  await startJobWorkers().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', message: 'jobs.inlineStartFailed', error: String(error) }));
  });
}
