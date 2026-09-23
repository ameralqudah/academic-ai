import { getEnv } from '@/config/env';

export type JobRunner = 'inline' | 'worker' | 'direct';

/**
 * How background work is executed here. Explicit configuration wins; without
 * it, Vercel keeps the previous in-process behaviour (its functions freeze
 * after responding and cannot poll a queue) and everything else queues and
 * runs inline.
 */
export function jobRunner(): JobRunner {
  const configured = getEnv().JOB_RUNNER;
  if (configured) return configured;
  return process.env.VERCEL ? 'direct' : 'inline';
}
