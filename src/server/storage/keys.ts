/**
 * Storage keys: built here, validated here, never accepted from a client.
 *
 * This file is small and it is the most security-sensitive part of the storage
 * layer, so the reasoning is worth setting out.
 *
 * A storage key is a path. Paths have a long history of being the weak point in
 * file-handling systems, in two ways that both apply here.
 *
 * **Traversal.** A key containing `../` escapes the directory it was meant to
 * stay inside. On a Render persistent disk that means reading the application's
 * own files, or another user's uploads. The defence is not to sanitise input —
 * sanitisers get outrun — but to never build a key from user input at all.
 * Every key this product stores is assembled from a user id and a dataset id,
 * both of which are UUIDs generated server-side. The original filename the user
 * chose is kept in the database column `original_name` and is never part of the
 * path.
 *
 * **Guessing.** Keys embed the owner's id as the first segment. That is not the
 * access control — the ownership check on the `datasets` row is — but it means
 * a key cannot accidentally be *constructed* for someone else's file by a bug
 * in a service, and it makes the per-user prefix listable and deletable as a
 * unit. Defence in depth: one layer failing should not be enough.
 *
 * `assertSafeKey` is the belt to that pair of braces. It runs before every call
 * into a provider, so even a key read back from the database — which could in
 * principle have been written by an older, buggier version of this code — is
 * checked before it reaches a filesystem.
 */

import { StorageError } from './provider';

/** UUIDs and the two fixed object names. Nothing else may appear in a key. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_KEY_LENGTH = 512;

export type DatasetKind = 'ORIGINAL' | 'CLEANED';

/**
 * The one place a dataset key is constructed.
 *
 *   datasets/{userId}/{datasetId}/original.csv
 *   datasets/{userId}/{datasetId}/cleaned.csv
 *
 * The extension comes from a fixed set rather than from the uploaded filename,
 * so a file called `report.csv.exe` cannot become a key ending in `.exe`.
 */
export function datasetKey(input: {
  userId: string;
  datasetId: string;
  kind: DatasetKind;
  extension: 'csv' | 'xlsx';
}): string {
  const name = input.kind === 'CLEANED' ? 'cleaned' : 'original';
  const key = `datasets/${input.userId}/${input.datasetId}/${name}.${input.extension}`;
  assertSafeKey(key);
  return key;
}

/** Every key belonging to one user, for bulk deletion when an account closes. */
export function userPrefix(userId: string): string {
  const prefix = `datasets/${userId}/`;
  assertSafeKey(`${prefix}x`);
  return prefix;
}

/** Every key belonging to one dataset, for "delete everything". */
export function datasetPrefix(userId: string, datasetId: string): string {
  const prefix = `datasets/${userId}/${datasetId}/`;
  assertSafeKey(`${prefix}x`);
  return prefix;
}

/**
 * Rejects anything that is not a plain, relative, well-formed key.
 *
 * Checked explicitly rather than by a single regular expression over the whole
 * string, because each rule has a distinct reason and a distinct failure
 * message — and because a reader of this code should be able to see what is
 * being defended against without decoding a pattern.
 */
export function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageError('storage.error.emptyKey');
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw new StorageError('storage.error.keyTooLong', { length: key.length, maximum: MAX_KEY_LENGTH });
  }

  // Absolute paths would escape the storage root entirely.
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new StorageError('storage.error.absoluteKey');
  }

  // Windows drive letters, and anything that looks like a URL or a scheme.
  if (/^[A-Za-z]:/.test(key) || key.includes('://')) {
    throw new StorageError('storage.error.absoluteKey');
  }

  // Backslashes are path separators on some platforms; only forward slashes here.
  if (key.includes('\\')) {
    throw new StorageError('storage.error.backslashInKey');
  }

  // Null bytes truncate paths in some system calls.
  if (key.includes('\0')) {
    throw new StorageError('storage.error.nullByteInKey');
  }

  const segments = key.split('/');

  for (const segment of segments) {
    if (segment === '' ) {
      throw new StorageError('storage.error.emptySegment');
    }
    // The traversal case, and the redundant-current-directory case.
    if (segment === '.' || segment === '..') {
      throw new StorageError('storage.error.traversalInKey');
    }
    if (!SAFE_SEGMENT.test(segment)) {
      throw new StorageError('storage.error.unsafeSegment', { segment });
    }
  }
}

/**
 * Whether a key belongs to a given user, judged from its shape.
 *
 * A cheap second check used before handing a key from the database to a
 * provider. It is not the authorisation — the `datasets` row is — but if these
 * two ever disagree, something is wrong that should stop the request rather
 * than quietly serve a file.
 */
export function keyBelongsTo(key: string, userId: string): boolean {
  return key.startsWith(`datasets/${userId}/`);
}
