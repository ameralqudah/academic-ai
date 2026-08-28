/**
 * Filesystem storage — the provider that runs against a Render persistent disk.
 *
 * **The warning that matters most about this provider.** A Render service
 * without a disk attached has an ephemeral filesystem: everything written to it
 * disappears on the next deploy or restart. Files would upload successfully,
 * work perfectly, and then be gone after the next release — the worst possible
 * failure mode, because nothing looks broken until a user comes back for their
 * data. `isConfigured()` therefore requires `STORAGE_LOCAL_DIR` to be set
 * explicitly rather than defaulting to a temporary directory, and the
 * application warns at boot if it is running in production without one.
 *
 * The root directory is configuration, never a constant. On Render it is the
 * mount path of the disk; in development it is a folder under the project. A
 * hard-coded path would work on exactly one machine.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { getEnv } from '@/config/env';

import { assertSafeKey } from './keys';
import { StorageError, type StorageProvider, type StoredMetadata, type StoredObject } from './provider';

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;

  private readonly root: string | null;

  constructor(root?: string) {
    const configured = root ?? getEnv().STORAGE_LOCAL_DIR;
    this.root = configured ? resolve(configured) : null;
  }

  isConfigured(): boolean {
    return this.root !== null;
  }

  /**
   * Resolves a key to an absolute path and proves the result is inside the
   * root.
   *
   * `assertSafeKey` has already rejected traversal, so this check should never
   * fire. It is here anyway because the cost of the check is a string compare
   * and the cost of being wrong is one user reading another's files. Two
   * independent defences against the same failure is the correct number for
   * this particular failure.
   */
  private pathFor(key: string): string {
    if (!this.root) {
      throw new StorageError('storage.error.notConfigured', { provider: 'local' });
    }

    assertSafeKey(key);

    const full = resolve(join(this.root, key));
    const boundary = this.root.endsWith(sep) ? this.root : this.root + sep;

    if (!full.startsWith(boundary)) {
      throw new StorageError('storage.error.escapedRoot', { key });
    }

    return full;
  }

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<StoredMetadata> {
    const path = this.pathFor(key);

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (error) {
      throw new StorageError('storage.error.writeFailed', { key }, { cause: error });
    }

    return { key, byteSize: bytes.byteLength, contentType, updatedAt: new Date() };
  }

  async get(key: string): Promise<StoredObject> {
    const path = this.pathFor(key);

    try {
      const buffer = await readFile(path);
      return { key, bytes: new Uint8Array(buffer) };
    } catch (error) {
      throw new StorageError('storage.error.notFound', { key }, { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);

    try {
      // `force` so deleting an already-absent object is not an error: a delete
      // that has to be retried should succeed the second time.
      await rm(path, { force: true });
    } catch (error) {
      throw new StorageError('storage.error.deleteFailed', { key }, { cause: error });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<StoredMetadata | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { key, byteSize: info.size, updatedAt: info.mtime };
    } catch {
      return null;
    }
  }

  /** Removes an entire prefix — used by "delete everything" and account closure. */
  async deletePrefix(prefix: string): Promise<void> {
    if (!this.root) {
      throw new StorageError('storage.error.notConfigured', { provider: 'local' });
    }

    // A prefix ends in a separator, which `assertSafeKey` rejects, so it is
    // validated by appending a placeholder segment first.
    assertSafeKey(`${prefix.replace(/\/$/, '')}/x`);

    const full = resolve(join(this.root, prefix));
    const boundary = this.root.endsWith(sep) ? this.root : this.root + sep;

    if (!full.startsWith(boundary)) {
      throw new StorageError('storage.error.escapedRoot', { key: prefix });
    }

    try {
      await rm(full, { recursive: true, force: true });
    } catch (error) {
      throw new StorageError('storage.error.deleteFailed', { key: prefix }, { cause: error });
    }
  }
}

/** SHA-256 of the stored bytes, for corruption detection and duplicate uploads. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
