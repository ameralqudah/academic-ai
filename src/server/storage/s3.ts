/**
 * S3-compatible object storage — Cloudflare R2, AWS S3, Backblaze B2, MinIO.
 *
 * Not in use yet. It exists now so that moving off the Render disk later is a
 * change to two environment variables rather than a change to the application,
 * which is the whole point of having a provider interface. The disk is the
 * right choice today; it is also the choice that stops working the moment the
 * service runs on more than one instance, and that day should not require a
 * rewrite.
 *
 * **Signed by hand, no SDK.** The AI providers in this project call REST
 * endpoints with `fetch` rather than pulling in a vendor SDK, and the same
 * reasoning applies here: `@aws-sdk/client-s3` is several megabytes of
 * dependency to sign a request and issue a PUT. Signature Version 4 is a
 * documented algorithm — a chain of HMACs over a canonical string — and it is
 * implemented below in about a hundred lines.
 *
 * **What is verified and what is not.** The signing chain is checked in
 * `scripts/smoke.ts` against an independent implementation, so the arithmetic
 * is known to be right. What has *not* been exercised is a real request to a
 * real bucket, because this project has no credentials to one. Before
 * `STORAGE_PROVIDER=s3` is switched on in production, a single upload and
 * download against the target bucket must be run and seen to work. That is
 * stated here rather than discovered later.
 */

import { createHash, createHmac } from 'node:crypto';

import { getEnv } from '@/config/env';

import { assertSafeKey } from './keys';
import { StorageError, type StorageProvider, type StoredMetadata, type StoredObject } from './provider';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD_HEADER = 'x-amz-content-sha256';

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * URI-encodes a path segment the way SigV4 requires.
 *
 * `encodeURIComponent` leaves `!'()*` alone; the signing specification does
 * not. A mismatch here produces a signature that is wrong only for keys
 * containing those characters — the kind of bug that passes every test written
 * with tidy filenames and fails in production on the first unusual one.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeSegment).join('/');
}

/** `20260827T120000Z` and `20260827`, the two timestamp forms SigV4 uses. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SigV4Input {
  method: string;
  host: string;
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  amzDate: string;
  dateStamp: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Builds the `Authorization` header for one request.
 *
 * Exported so the smoke tests can check the chain against an independent
 * implementation without needing a network or a bucket.
 */
export function signRequest(input: SigV4Input): Record<string, string> {
  const headers: Record<string, string> = {
    host: input.host,
    [UNSIGNED_PAYLOAD_HEADER]: input.payloadHash,
    'x-amz-date': input.amzDate,
    ...Object.fromEntries(
      Object.entries(input.extraHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    input.method,
    input.path,
    '', // no query string is used by any call in this provider
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${input.dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  // The four-step key derivation. Each HMAC narrows the key to one date, one
  // region and one service, so a leaked signing key is useless the next day.
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, input.dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor() {
    const env = getEnv();
    this.endpoint = (env.S3_ENDPOINT ?? '').replace(/\/$/, '');
    this.bucket = env.S3_BUCKET ?? '';
    this.region = env.S3_REGION ?? 'auto';
    this.accessKeyId = env.S3_ACCESS_KEY_ID ?? '';
    this.secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? '';
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.bucket && this.accessKeyId && this.secretAccessKey);
  }

  private request(method: string, key: string, body?: Uint8Array, contentType?: string) {
    if (!this.isConfigured()) {
      throw new StorageError('storage.error.notConfigured', { provider: 's3' });
    }

    assertSafeKey(key);

    const url = new URL(`${this.endpoint}/${this.bucket}/${encodeKeyPath(key)}`);
    const { amzDate, dateStamp } = amzDates(new Date());
    const payloadHash = body ? sha256Hex(body) : sha256Hex('');

    const headers = signRequest({
      method,
      host: url.host,
      path: url.pathname,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      payloadHash,
      amzDate,
      dateStamp,
      extraHeaders: contentType ? { 'content-type': contentType } : undefined,
    });

    return { url: url.toString(), headers };
  }

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<StoredMetadata> {
    const { url, headers } = this.request('PUT', key, bytes, contentType);

    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(bytes),
    });

    if (!response.ok) {
      throw new StorageError('storage.error.writeFailed', { key, status: response.status });
    }

    return { key, byteSize: bytes.byteLength, contentType, updatedAt: new Date() };
  }

  async get(key: string): Promise<StoredObject> {
    const { url, headers } = this.request('GET', key);
    const response = await fetch(url, { method: 'GET', headers });

    if (!response.ok) {
      throw new StorageError('storage.error.notFound', { key, status: response.status });
    }

    return {
      key,
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = this.request('DELETE', key);
    const response = await fetch(url, { method: 'DELETE', headers });

    // 404 on delete is success: the object is not there, which is the goal.
    if (!response.ok && response.status !== 404) {
      throw new StorageError('storage.error.deleteFailed', { key, status: response.status });
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StoredMetadata | null> {
    const { url, headers } = this.request('HEAD', key);
    const response = await fetch(url, { method: 'HEAD', headers });

    if (!response.ok) return null;

    const length = Number(response.headers.get('content-length') ?? 0);
    return {
      key,
      byteSize: Number.isFinite(length) ? length : 0,
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }
}
