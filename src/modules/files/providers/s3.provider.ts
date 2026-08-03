import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageConfig } from '../storage.config.js';
import type {
  ObjectHead,
  SignDownloadInput,
  SignUploadInput,
  SignedDownload,
  SignedUpload,
  StorageHealth,
  StorageOperation,
  StorageProvider,
} from './storage.provider.js';
import { StorageError } from './storage.provider.js';

/**
 * The storage class {@link S3StorageProvider.archive} moves objects to.
 *
 * Glacier Instant Retrieval, not Deep Archive: the archived half of retention is
 * KYC and safety evidence (R-FILE-21), and the situation that reads it is a
 * regulator or an investigator asking a question. Deep Archive answers in twelve
 * hours at a third of the price — the wrong trade for a request that arrives with
 * a deadline attached.
 *
 * A constant rather than config because doc 08 §2 defines no key for it; see the
 * phase-5 report.
 */
const ARCHIVE_STORAGE_CLASS = 'GLACIER_IR';

/** S3 deletes at most this many objects per `DeleteObjects` call. */
const DELETE_BATCH_SIZE = 1000;

/**
 * Total object size out of a `Content-Range: bytes 0-511/12345` header.
 *
 * This is why {@link S3StorageProvider.head} is one round trip and not two: a
 * ranged `GET` already carries the full length, so asking `HeadObject` first
 * would buy nothing but latency (doc 07 §2).
 * @param contentRange The response header, if present.
 * @returns The total size, or `null` when it cannot be parsed.
 */
function totalSizeFromContentRange(contentRange: string | undefined): number | null {
  const total = contentRange?.split('/')[1];
  if (total == null || total === '*') return null;
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Re-encode a digest between S3's base64 and this module's hex.
 *
 * S3 returns `ChecksumSHA256` base64-encoded; the client declares it as hex
 * (doc 02 §2.1) and the completion check compares the two directly. Without this
 * every checksum would mismatch, and `CHECKSUM_MISMATCH` would tell users to
 * re-upload a file that was never corrupt.
 * @param value The base64 digest, if the object carries one.
 * @returns The lowercase hex digest, or `null`.
 */
function base64ToHex(value: string | undefined): string | null {
  if (!value) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded.toString('hex') : null;
}

/** Hex → base64, for handing a client-declared digest back to S3. */
function hexToBase64(value: string): string {
  return Buffer.from(value, 'hex').toString('base64');
}

/**
 * Whether a retry could plausibly succeed (doc 07 §4).
 *
 * Status-driven rather than name-driven: a list of vendor error names is a list
 * that goes stale silently, and the mapping doc 07 §4 defines is entirely about
 * status. Anything with no HTTP status at all reached us before the service
 * answered — a timeout, a refused connection, a DNS failure — and those are the
 * retryable case by definition.
 * @param error The SDK error.
 * @returns `true` when a retry is worth attempting.
 */
function isRetryable(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (typeof status === 'number') return status >= 500 || status === 429;
  return true;
}

/** Whether an SDK error means "no such object" rather than a failure. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/**
 * Build the SDK client from configuration.
 *
 * `credentials` is omitted rather than set to `null` when unconfigured, so the
 * SDK's default chain finds the instance role (doc 08 §2).
 * @param storageConfig Resolved storage configuration.
 * @returns A configured client.
 */
function buildClient(storageConfig: StorageConfig): S3Client {
  return new S3Client({
    region: storageConfig.region,
    ...(storageConfig.endpoint != null ? { endpoint: storageConfig.endpoint } : {}),
    forcePathStyle: storageConfig.forcePathStyle,
    ...(storageConfig.credentials != null ? { credentials: storageConfig.credentials } : {}),
    // `maxRetries` counts retries; the SDK counts total attempts (doc 08 §2).
    maxAttempts: storageConfig.maxRetries + 1,
    requestHandler: {
      requestTimeout: storageConfig.requestTimeoutMs,
      connectionTimeout: storageConfig.requestTimeoutMs,
    },
  });
}

/**
 * The production {@link StorageProvider}: S3, and every service that speaks its
 * API (files doc 01 §12 phase 5, doc 07 §5).
 *
 * MinIO, Cloudflare R2, DigitalOcean Spaces, and Ceph are **this class with a
 * different `endpoint`**, which is the payoff for defining the contract against
 * S3 semantics rather than against AWS (FILES-OD-12). Four vendors ship as a
 * configuration string instead of four implementations.
 *
 * Nothing here logs. FILE-INV-2 applies inside the provider too, and a key or a
 * signed URL in a debug line is the same disclosure as one in a response.
 */
export class S3StorageProvider implements StorageProvider {
  /** Persisted in `files.storage_provider`; never renamed (doc 03 §3.1). */
  readonly name = 's3';

  private readonly bucket: string;

  /**
   * @param storageConfig Bucket, region, credentials, encryption, and timeouts.
   * @param client The SDK client. Injectable so the error mapping and the
   *        version sweep in {@link erase} are testable without a bucket.
   * @param now Clock seam (doc 07 §3 rule 5) — expiry arithmetic is ours, not
   *        the SDK's, and a test has to be able to move it.
   */
  constructor(
    private readonly storageConfig: StorageConfig,
    private readonly client: S3Client = buildClient(storageConfig),
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!storageConfig.bucket) {
      throw new Error('STORAGE_BUCKET is required when STORAGE_PROVIDER=s3 (files doc 08 §7)');
    }
    this.bucket = storageConfig.bucket;
  }

  /**
   * Mint a write permission bound to one key, method, and content-type.
   *
   * **`content-type` is signed explicitly.** The S3 presigner adds it to
   * `unsignableHeaders` by default, which would leave a permission that writes
   * any content-type to the key — R-FILE-2 requires otherwise, and
   * `signableHeaders` wins over `unsignableHeaders` in the signer.
   *
   * The encryption headers are forced unhoistable by the presigner, so they stay
   * signed headers the client must send; they are returned in `headers` for
   * exactly that reason. The declared checksum is made unhoistable deliberately:
   * as a query parameter S3 would not enforce it, and a binding that is not
   * enforced is worse than none.
   *
   * **`maxBytes` is not bound into the signature.** A presigned `PUT` has no
   * mechanism for it — a size range is a presigned *POST* policy feature — so the
   * ceiling is enforced at completion, where an oversized object is deleted and
   * never becomes `READY`. This is a documented gap against doc 07 §3 rule 3; see
   * the phase-5 report.
   * @param input Key, content-type, size ceiling, and TTL.
   * @returns The scoped permission and the headers the client must send.
   * @throws {StorageError} On any signing failure.
   */
  async signUpload(input: SignUploadInput): Promise<SignedUpload> {
    const headers: Record<string, string> = {
      'Content-Type': input.contentType,
      'x-amz-server-side-encryption': this.storageConfig.serverSideEncryption,
    };
    if (this.storageConfig.kmsKeyId != null) {
      headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.storageConfig.kmsKeyId;
    }
    if (input.checksumSha256 != null) {
      headers['x-amz-checksum-sha256'] = hexToBase64(input.checksumSha256);
    }

    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ContentType: input.contentType,
          ServerSideEncryption: this.storageConfig.serverSideEncryption,
          ...(this.storageConfig.kmsKeyId != null
            ? { SSEKMSKeyId: this.storageConfig.kmsKeyId }
            : {}),
          ...(input.checksumSha256 != null
            ? { ChecksumSHA256: hexToBase64(input.checksumSha256) }
            : {}),
        }),
        {
          expiresIn: input.ttlSeconds,
          signableHeaders: new Set(['content-type']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      );

      return {
        method: 'PUT',
        url,
        headers,
        expiresAt: new Date(this.now().getTime() + input.ttlSeconds * 1000),
      };
    } catch (error) {
      throw this.wrap('signUpload', error);
    }
  }

  /**
   * Mint a read permission for one key (R-FILE-12 — per request, never cached).
   *
   * `ResponseContentDisposition` and `ResponseContentType` are part of the
   * signature, so a holder cannot re-point the response headers: swapping
   * `inline` for `attachment` invalidates it.
   * @param input Key, TTL, content-type, disposition, and display filename.
   * @returns The URL and its expiry.
   * @throws {StorageError} On any signing failure.
   */
  async signDownload(input: SignDownloadInput): Promise<SignedDownload> {
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ResponseContentType: input.contentType,
          ResponseContentDisposition: `${input.disposition}; filename="${input.fileName}"`,
        }),
        { expiresIn: input.ttlSeconds },
      );

      return { url, expiresAt: new Date(this.now().getTime() + input.ttlSeconds * 1000) };
    } catch (error) {
      throw this.wrap('signDownload', error);
    }
  }

  /**
   * Size, content-type, checksum, and leading bytes — in one round trip.
   *
   * A ranged `GET` carries the total length in `Content-Range`, so it answers
   * everything `HeadObject` would and returns the peek as well. `ChecksumMode`
   * is enabled so a digest S3 already holds is not recomputed locally.
   * @param key The object key.
   * @param peekBytes How many leading bytes to return.
   * @returns The head, or `null` when the object does not exist.
   * @throws {StorageError} On any failure other than absence.
   */
  async head(key: string, peekBytes: number): Promise<ObjectHead | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${Math.max(peekBytes - 1, 0)}`,
          ChecksumMode: 'ENABLED',
        }),
      );

      const peek = Buffer.from((await response.Body?.transformToByteArray()) ?? []);
      return {
        sizeBytes: totalSizeFromContentRange(response.ContentRange) ?? peek.length,
        contentType: response.ContentType ?? null,
        checksumSha256: base64ToHex(response.ChecksumSHA256),
        peek,
      };
    } catch (error) {
      // Absence is an answer, not a failure: it becomes `409 UPLOAD_NOT_FOUND`
      // and the row stays PENDING so the client can re-PUT (doc 07 §4).
      if (isNotFound(error)) return null;
      throw this.wrap('head', error);
    }
  }

  /**
   * Remove the current version, leaving earlier ones (R-FILE-22).
   *
   * On the versioned bucket this platform mandates that means a delete marker —
   * correct for the only caller, the sweeper reclaiming an orphan whose bytes
   * were never verified and never referenced (doc 08 §2.2).
   * @param key The object key.
   * @throws {StorageError} On any failure other than absence.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // S3 answers `204` for an absent key, so reaching here means a real
      // failure — but an SDK that maps it to 404 must still be a success
      // (R-FILE-23).
      if (isNotFound(error)) return;
      throw this.wrap('delete', error);
    }
  }

  /**
   * Destroy every version of an object, permanently (R-FILE-23).
   *
   * **The one operation that must survive bucket versioning.** A plain delete
   * would write a marker and leave the bytes retrievable by anyone who can name
   * a version id, while `file.erased` recorded — durably, in the audit trail —
   * that they were gone. An erasure request under a privacy obligation would be
   * logged as honoured and not be (doc 08 §2.2).
   *
   * Versions are listed by prefix and filtered to the **exact** key: a prefix
   * listing also returns longer keys that merely start with it, and erasing
   * those would destroy unrelated files.
   * @param key The object key.
   * @throws {StorageError} On any failure other than absence.
   */
  async erase(key: string): Promise<void> {
    try {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;

      do {
        const listed = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: key,
            ...(keyMarker != null ? { KeyMarker: keyMarker } : {}),
            ...(versionIdMarker != null ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        );

        const targets = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
          .filter((entry) => entry.Key === key && entry.VersionId != null)
          .map((entry) => ({ Key: key, VersionId: entry.VersionId as string }));

        for (let start = 0; start < targets.length; start += DELETE_BATCH_SIZE) {
          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: targets.slice(start, start + DELETE_BATCH_SIZE), Quiet: true },
            }),
          );
        }

        keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
        versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
      } while (keyMarker != null || versionIdMarker != null);
    } catch (error) {
      // Nothing to erase is an erasure that succeeded (R-FILE-23).
      if (isNotFound(error)) return;
      throw this.wrap('erase', error);
    }
  }

  /**
   * Move an object to cold storage, preserving the bytes (R-FILE-21).
   *
   * A self-referential copy is how S3 changes a storage class; `MetadataDirective:
   * COPY` keeps the content-type and everything else intact, and the encryption
   * settings are restated because a copy does not inherit them.
   * @param key The object key.
   * @throws {StorageError} On any provider failure.
   */
  async archive(key: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: key,
          CopySource: `${this.bucket}/${encodeURIComponent(key)}`,
          MetadataDirective: 'COPY',
          StorageClass: ARCHIVE_STORAGE_CLASS,
          ServerSideEncryption: this.storageConfig.serverSideEncryption,
          ...(this.storageConfig.kmsKeyId != null
            ? { SSEKMSKeyId: this.storageConfig.kmsKeyId }
            : {}),
        }),
      );
    } catch (error) {
      throw this.wrap('archive', error);
    }
  }

  /**
   * Liveness, credentials, and bucket reachability for the readiness probe.
   *
   * **Never throws** (doc 07 §2): a probe that raises cannot report degradation,
   * and the three flags exist so an operator can tell "the network is down" from
   * "the key was rotated" without reading a stack trace.
   * @returns The health signal.
   */
  async health(): Promise<StorageHealth> {
    const startedAt = this.now().getTime();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return {
        reachable: true,
        bucketExists: true,
        credentialsValid: true,
        latencyMs: this.now().getTime() - startedAt,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      // A status at all means the service answered — so it is reachable, and
      // what failed is the bucket name or the credentials.
      return {
        reachable: typeof status === 'number',
        bucketExists: status !== 404,
        credentialsValid: status !== 403 && status !== 401,
        latencyMs: this.now().getTime() - startedAt,
      };
    }
  }

  /**
   * Wrap a vendor error so nothing SDK-shaped escapes (doc 07 §3 rule 1).
   * @param operation Which contract method failed.
   * @param error The SDK error, retained on `cause` for logs only.
   * @returns The error to throw.
   */
  private wrap(operation: StorageOperation, error: unknown): StorageError {
    return new StorageError(operation, isRetryable(error), error);
  }
}
