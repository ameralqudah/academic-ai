/**
 * File storage behind one interface — the same shape as the AI, billing and
 * email providers, and for the same reason: the feature ships and is testable
 * before anyone signs up for a storage vendor.
 *
 * What this layer deliberately does *not* do is decide who may read a file.
 * A `StorageProvider` given a key will return the bytes at that key, always.
 * Authorisation happens one layer up, against the `datasets` row that owns the
 * key, and it happens on every single read. A storage key is a location, never
 * a credential — the moment a system treats "knows the path" as "may read the
 * file", one leaked identifier exposes a stranger's research data.
 */

export interface StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface StoredMetadata {
  key: string;
  byteSize: number;
  contentType?: string;
  updatedAt?: Date;
}

export interface StorageProvider {
  readonly name: 'local' | 's3';

  /** True when the provider has everything it needs to work. */
  isConfigured(): boolean;

  put(key: string, bytes: Uint8Array, contentType?: string): Promise<StoredMetadata>;
  get(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StoredMetadata | null>;
}

/** Raised for every storage failure, so callers never see vendor-specific errors. */
export class StorageError extends Error {
  constructor(
    readonly reasonKey: string,
    readonly params: Record<string, string | number> = {},
    options?: { cause?: unknown },
  ) {
    super(reasonKey, options);
    this.name = 'StorageError';
  }
}
