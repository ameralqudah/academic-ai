/* Pure, and apart from the storage module, so it can be tested without a store. */

const PROBE_PREFIX = 'health/probe';

/**
 * A key nothing has been written to before.
 *
 * The probe wrote one fixed key and read it back, and in production it failed
 * on every start with a mismatch — while documents were being stored and
 * downloaded without trouble. An object store may serve an overwritten key from
 * a cache for a while, so what came back was an earlier probe's stamp. A key
 * that has never existed cannot be answered from a cache, which makes the check
 * test the store and not its caching.
 */
export function probeKey(now = Date.now(), random = Math.random()): string {
  return `${PROBE_PREFIX}-${now.toString(36)}-${Math.floor(random * 1e9).toString(36)}.txt`;
}
