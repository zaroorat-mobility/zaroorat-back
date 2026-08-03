/**
 * The storage backend contract (files doc 07 §2).
 *
 * This is the only place a method signature for storage appears. Application
 * code depends on this abstraction, never on a vendor SDK, so S3 is swappable
 * for a mock — or for MinIO, R2, Spaces, or Ceph, which are all `s3` with a
 * different endpoint (FILES-OD-12).
 */

/** Inputs for a write permission scoped to exactly one object (R-FILE-2). */
export interface SignUploadInput {
  key: string;
  contentType: string;
  /** Hard ceiling the provider MUST bind into the signature, not merely check. */
  maxBytes: number;
  ttlSeconds: number;
  /** Enforced by the provider when supported; re-verified at completion regardless. */
  checksumSha256?: string;
}

/** A single-use write permission. The only signed URL in any response body. */
export interface SignedUpload {
  method: 'PUT';
  url: string;
  /** Headers the client MUST send verbatim; part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** Inputs for a read permission (R-FILE-12 — minted per request, never cached). */
export interface SignDownloadInput {
  key: string;
  ttlSeconds: number;
  contentType: string;
  disposition: 'inline' | 'attachment';
  /** Rendered into Content-Disposition; already sanitized per doc 02 §5.1. */
  fileName: string;
}

/** A short-lived read permission. */
export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

/** Object metadata plus enough leading bytes to identify the content. */
export interface ObjectHead {
  sizeBytes: number;
  /** The provider's stored content-type — a claim, like the client's. */
  contentType: string | null;
  /** Provider-computed digest when available; null forces local computation. */
  checksumSha256: string | null;
  /** First N bytes, for magic-number and dimension checks (doc 02 §5, §5.2). */
  peek: Buffer;
}

/** Readiness signal for the storage contributor (doc 09 §3). */
export interface StorageHealth {
  reachable: boolean;
  bucketExists: boolean;
  credentialsValid: boolean;
  latencyMs: number;
}

/** The operations a {@link StorageError} can describe. */
export type StorageOperation =
  'signUpload' | 'signDownload' | 'head' | 'delete' | 'erase' | 'archive' | 'health';

/**
 * The only error type that escapes a provider.
 *
 * Providers never throw a vendor error: doc 04 §6's fail-closed mapping branches
 * on `retryable`, and the module above must never have to understand an SDK's
 * error shape. `cause` is retained for logs and is **never** serialized into a
 * response (doc 04 §5).
 */
export class StorageError extends Error {
  /**
   * @param operation Which contract method failed.
   * @param retryable Whether a retry could plausibly succeed (timeouts, 5xx,
   *        throttling) as opposed to a configuration fault (bad credentials,
   *        missing bucket).
   * @param cause The provider-native error, for logging only.
   */
  constructor(
    readonly operation: StorageOperation,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(`Storage operation "${operation}" failed`);
    this.name = 'StorageError';
  }
}

/**
 * A storage backend. Implementations are stateless, injected by name
 * (`storageProvider`), and selected by configuration — never by a caller.
 *
 * Every method is total: it either fulfils its contract or throws a
 * {@link StorageError}. None returns a partial success.
 */
export interface StorageProvider {
  /** Stable identifier written to `files.storage_provider`. Never renamed — the
   *  value is persisted, and changing it orphans history (doc 03 §3.1). */
  readonly name: string;

  /**
   * Mint a write permission for exactly one key.
   *
   * The returned URL MUST be constrained to the given method, key, content-type,
   * and size ceiling. A permission that can write a second key, or a different
   * content-type, violates R-FILE-2 regardless of what the caller does with it.
   * @param input Key, content-type, size ceiling, and TTL.
   * @returns The scoped permission and its expiry.
   * @throws {StorageError} On any provider failure.
   */
  signUpload(input: SignUploadInput): Promise<SignedUpload>;

  /**
   * Mint a read permission for exactly one key.
   * @param input Key, TTL, content-type, disposition, and display filename.
   * @returns The URL and its expiry.
   * @throws {StorageError} On any provider failure.
   */
  signDownload(input: SignDownloadInput): Promise<SignedDownload>;

  /**
   * Object metadata plus the first `peekBytes` of content — the single call that
   * backs completion validation (R-FILE-5).
   *
   * Combining "does it exist" with "what is it" is deliberate: two round trips
   * to answer one question is the difference between a fast completion and a
   * slow one.
   * @param key The object key.
   * @param peekBytes How many leading bytes to return.
   * @returns The head, or `null` when the object does not exist.
   * @throws {StorageError} On any provider failure other than absence.
   */
  head(key: string, peekBytes: number): Promise<ObjectHead | null>;

  /**
   * Remove the **current version** of an object.
   *
   * On a versioned bucket this writes a delete marker and earlier versions
   * survive — correct here, because the only caller is the sweeper reclaiming an
   * orphan whose bytes were never verified and never referenced (R-FILE-22).
   *
   * Idempotent: an already-absent object is a success (R-FILE-23).
   * @param key The object key.
   * @throws {StorageError} On any provider failure other than absence.
   */
  delete(key: string): Promise<void>;

  /**
   * Destroy an object **and every version of it**, permanently.
   *
   * The one operation that must survive bucket versioning. A plain delete on a
   * versioned bucket leaves the bytes recoverable indefinitely, so using it for
   * retention would mean an erasure request was recorded as honoured and not
   * performed (doc 08 §2.2, R-FILE-23).
   *
   * Implementations MUST enumerate version ids and remove all of them, including
   * delete markers. Idempotent, like {@link delete}.
   * @param key The object key.
   * @throws {StorageError} On any provider failure other than absence.
   */
  erase(key: string): Promise<void>;

  /**
   * Move an object to a colder storage class, preserving the bytes.
   *
   * The `ARCHIVED` half of retention (R-FILE-21) — never a delete. "We archive,
   * we don't shred what compliance or a dispute may need."
   * @param key The object key.
   * @throws {StorageError} On any provider failure.
   */
  archive(key: string): Promise<void>;

  /**
   * Liveness, credentials, and bucket reachability, for the readiness probe.
   *
   * Runs on the probe's schedule, never in the request path (doc 09 §3).
   * @returns The health signal; does not throw for an unhealthy backend.
   */
  health(): Promise<StorageHealth>;
}
