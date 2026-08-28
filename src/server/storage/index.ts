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
export function resetStorageCache(): void {
  cached = null;
}

export { assertSafeKey, datasetKey, datasetPrefix, keyBelongsTo, userPrefix } from './keys';
export type { DatasetKind } from './keys';
export { checksumOf, LocalStorageProvider } from './local';
export { StorageError } from './provider';
export type { StorageProvider, StoredMetadata, StoredObject } from './provider';
export { S3StorageProvider } from './s3';
