/**
 * Chooses the storage provider from configuration.
 *
 * Deliberately different from how the email module degrades. Email falls back
 * to a console provider when nothing is configured, because a password-reset
 * link printed to the log is better than a crash and the developer sees it
 * immediately. Storage cannot do that: silently accepting an upload it has
 * nowhere to keep would report success to the user and lose their data, and
 * they would not find out until they came back for it.
 *
 * So a misconfigured storage layer fails loudly. `isStorageConfigured()` lets
 * `/api/health` report it as a dependency alongside the database and the AI
 * provider, which is how the operator learns about it before a user does.
 */

import { getEnv } from '@/config/env';
import { logger } from '@/lib/logger';

import { LocalStorageProvider } from './local';
import { StorageError, type StorageProvider } from './provider';
import { S3StorageProvider } from './s3';
import { probeKey } from './keys-probe';

let cached: StorageProvider | null = null;

export function storageProvider(): StorageProvider {
  if (cached) return cached;

  const env = getEnv();

  if (env.STORAGE_PROVIDER === 's3') {
    const s3 = new S3StorageProvider();
    if (!s3.isConfigured()) {
      throw new StorageError('storage.error.notConfigured', { provider: 's3' });
    }
    cached = s3;
    return cached;
  }

  const local = new LocalStorageProvider();
  if (!local.isConfigured()) {
    throw new StorageError('storage.error.notConfigured', { provider: 'local' });
  }

  /*
   * The failure mode this warning exists for: a Render service with no disk
   * attached has an ephemeral filesystem. Uploads succeed, everything works,
   * and the files vanish at the next deploy — with nothing appearing broken
   * until a user returns for data that is gone.
   */
  if (env.NODE_ENV === 'production') {
    logger.warn('storage.local.inProduction', {
      directory: env.STORAGE_LOCAL_DIR,
      detail:
        'Using filesystem storage. This only survives restarts if STORAGE_LOCAL_DIR points at a mounted persistent disk. Without one, every uploaded file is lost on the next deploy.',
    });
  }

  cached = local;
  return cached;
}

/** For `/api/health`: is storage usable, and by which provider? */
export function storageStatus(): { provider: 'local' | 's3'; configured: boolean; detail?: string } {
  const env = getEnv();

  if (env.STORAGE_PROVIDER === 's3') {
    const s3 = new S3StorageProvider();
    return {
      provider: 's3',
      configured: s3.isConfigured(),
      detail: s3.isConfigured() ? undefined : 'S3_ENDPOINT, S3_BUCKET and credentials are required.',
    };
  }

  const configured = Boolean(env.STORAGE_LOCAL_DIR);
  return {
    provider: 'local',
    configured,
    detail: configured ? undefined : 'STORAGE_LOCAL_DIR is not set.',
  };
}

/** Test seam: the provider is cached for the life of the process. */
export interface StorageProbe {
  provider: 'local' | 's3';
  ok: boolean;
  /** Which step failed: configuring, writing, reading back, or nothing. */
  stage?: 'configure' | 'write' | 'read';
  reason?: string;
  /** The HTTP status the store answered with, when it is an HTTP store. */
  status?: number;
  detail?: string;
  checkedAt: string;
}

/**
 * Whether a file can actually be stored and read back, right now.
 *
 * `storageStatus` answers "are the variables set", and they were: the store
 * behind them had been paused by its host for inactivity, every generated
 * document failed at the last step, and nothing anywhere said why. Writing a
 * few bytes and reading them back is the only check that would have caught it.
 *
 * Cached for a minute so that opening the admin page is not a write per visit.
 * Never throws — it reports.
 */
/* The key itself is made in `keys-probe`, which says why it is never the same twice. */

/*
 * A store that does not answer must not hold the page that reports on it. An
 * unreachable host has no status to return — it simply never returns — and the
 * admin page waited on it for as long as the platform allowed.
 */
const PROBE_TIMEOUT_MS = 5_000;

function within<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StorageError('storage.error.timeout', { afterMs: PROBE_TIMEOUT_MS })),
      PROBE_TIMEOUT_MS,
    );

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
const PROBE_TTL_MS = 60_000;
let lastProbe: { at: number; result: StorageProbe } | null = null;

export async function probeStorage(options: { fresh?: boolean } = {}): Promise<StorageProbe> {
  if (!options.fresh && lastProbe && Date.now() - lastProbe.at < PROBE_TTL_MS) {
    return lastProbe.result;
  }

  const provider = getEnv().STORAGE_PROVIDER === 's3' ? 's3' : 'local';
  const checkedAt = new Date().toISOString();
  let stage: StorageProbe['stage'] = 'configure';
  let result: StorageProbe;

  try {
    const store = storageProvider();
    const stamp = `ok ${checkedAt}`;
    const key = probeKey();

    stage = 'write';
    await within(store.put(key, new TextEncoder().encode(stamp), 'text/plain'));

    stage = 'read';
    const back = new TextDecoder().decode((await within(store.get(key))).bytes);
    if (back !== stamp) throw new StorageError('storage.error.probeMismatch');

    /*
     * Tidied away, since every probe now leaves an object behind. Not part of
     * the verdict: a store that writes and reads is working, and one that will
     * not delete a probe file is no reason to tell the admin it is down.
     */
    await within(store.delete(key)).catch(() => undefined);

    result = { provider, ok: true, checkedAt };
  } catch (error) {
    const params = error instanceof StorageError ? error.params : {};

    result = {
      provider,
      ok: false,
      stage,
      reason: error instanceof StorageError ? error.reasonKey : String(error).slice(0, 200),
      ...(typeof params.status === 'number' ? { status: params.status } : {}),
      ...(typeof params.detail === 'string' ? { detail: params.detail } : {}),
      checkedAt,
    };

    logger.error('storage.probeFailed', { ...result });
  }

  lastProbe = { at: Date.now(), result };
  return result;
}

export function resetStorageCache(): void {
  cached = null;
  lastProbe = null;
}

export { assertSafeKey, datasetKey, datasetPrefix, keyBelongsTo, userPrefix } from './keys';
export type { DatasetKind } from './keys';
export { checksumOf, LocalStorageProvider } from './local';
export { StorageError } from './provider';
export type { StorageProvider, StoredMetadata, StoredObject } from './provider';
export { S3StorageProvider } from './s3';
