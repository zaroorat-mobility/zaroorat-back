import { createHmac, randomUUID } from 'node:crypto';
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

/** Host used in minted URLs. Never resolves — nothing here performs network I/O. */
const MOCK_HOST = 'https://mock-storage.local';

/** Signing key for mock signatures. Not a secret: it protects nothing real. */
const MOCK_SIGNING_KEY = 'mock-storage-signing-key';

/** One stored version of an object. The newest is the current version. */
interface MockVersion {
  versionId: string;
  body: Buffer;
  contentType: string;
  /** A delete marker hides earlier versions without removing them. */
  isDeleteMarker: boolean;
  storageClass: 'STANDARD' | 'ARCHIVE';
}

/** A failure to inject on the next call to an operation. */
interface InjectedFailure {
  retryable: boolean;
  /** Remaining calls to fail. `Infinity` until cleared. */
  remaining: number;
}

/** Why a mock URL was rejected — surfaced so tests assert the cause, not just failure. */
export type MockUrlRejection =
  'malformed' | 'bad-signature' | 'expired' | 'wrong-method' | 'wrong-content-type' | 'too-large';

/** The outcome of presenting a minted URL back to the mock. */
export type MockUrlVerdict = { ok: true; key: string } | { ok: false; reason: MockUrlRejection };

/**
 * In-process {@link StorageProvider} for development and every test.
 *
 * **A first-class deliverable, not a test fixture** (files doc 07 §7). It is what
 * makes acceptance criterion #10 — "provider swap is config-only" — demonstrable,
 * and what lets the whole suite run with no bucket and no network.
 *
 * Three things it models that a naive `Map` would not:
 *
 * 1. **Versions.** The bucket is versioned in production (doc 08 §2.2), so
 *    `delete()` here writes a delete marker and earlier versions survive, while
 *    `erase()` removes every version. A mock without versions would let the
 *    erase test pass against a provider that never reproduced the bug it guards.
 * 2. **Verifiable signatures.** {@link verifyUrl} re-derives the HMAC, so an
 *    expired URL, a wrong key, or a swapped method genuinely fails — a mock that
 *    returned an opaque string could not prove R-FILE-2 or R-FILE-16.
 * 3. **An injected clock.** TTL expiry is testable without `setTimeout`, which
 *    `node:test` cannot move here because ioredis and Prisma need real timers.
 */
export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock';

  /** Every version ever written, oldest first, keyed by object key. */
  private readonly objects = new Map<string, MockVersion[]>();

  /** Failures to inject, by operation. */
  private readonly failures = new Map<StorageOperation, InjectedFailure>();

  /** Call counts, so a test can assert the API wrote nothing (doc 06 §3 #1). */
  readonly calls: Record<StorageOperation, number> = {
    signUpload: 0,
    signDownload: 0,
    head: 0,
    delete: 0,
    erase: 0,
    archive: 0,
    health: 0,
  };

  /**
   * @param now Clock seam. Defaults to the real clock; tests replace it to move
   *        past a TTL without touching timers.
   */
  constructor(private now: () => Date = () => new Date()) {}

  // ── StorageProvider ────────────────────────────────────────────────────────

  /**
   * Mint a write permission bound to one key, method, content-type, and size.
   * @param input Key, content-type, size ceiling, and TTL.
   * @returns The scoped permission.
   * @throws {StorageError} When a failure is injected for `signUpload`.
   */
  async signUpload(input: SignUploadInput): Promise<SignedUpload> {
    this.record('signUpload');
    const expiresAt = new Date(this.now().getTime() + input.ttlSeconds * 1000);
    const url = this.sign('PUT', input.key, expiresAt, {
      ct: input.contentType,
      max: String(input.maxBytes),
    });
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': input.contentType },
      expiresAt,
    };
  }

  /**
   * Mint a read permission for one key.
   * @param input Key, TTL, content-type, disposition, and display filename.
   * @returns The URL and its expiry.
   * @throws {StorageError} When a failure is injected for `signDownload`.
   */
  async signDownload(input: SignDownloadInput): Promise<SignedDownload> {
    this.record('signDownload');
    const expiresAt = new Date(this.now().getTime() + input.ttlSeconds * 1000);
    const url = this.sign('GET', input.key, expiresAt, {
      ct: input.contentType,
      disp: input.disposition,
    });
    return { url, expiresAt };
  }

  /**
   * Read the current version's metadata and leading bytes.
   * @param key The object key.
   * @param peekBytes How many leading bytes to return.
   * @returns The head, or `null` when absent or hidden by a delete marker.
   * @throws {StorageError} When a failure is injected for `head`.
   */
  async head(key: string, peekBytes: number): Promise<ObjectHead | null> {
    this.record('head');
    const current = this.currentVersion(key);
    if (!current) return null;
    return {
      sizeBytes: current.body.length,
      contentType: current.contentType,
      checksumSha256: null,
      peek: current.body.subarray(0, peekBytes),
    };
  }

  /**
   * Write a delete marker. Earlier versions survive, as on a versioned bucket.
   * @param key The object key.
   * @throws {StorageError} When a failure is injected for `delete`.
   */
  async delete(key: string): Promise<void> {
    this.record('delete');
    const versions = this.objects.get(key);
    // Idempotent: nothing there, or already hidden, is a success (R-FILE-23).
    if (!versions || versions.length === 0) return;
    if (versions[versions.length - 1]?.isDeleteMarker) return;
    versions.push({
      versionId: randomUUID(),
      body: Buffer.alloc(0),
      contentType: '',
      isDeleteMarker: true,
      storageClass: 'STANDARD',
    });
  }

  /**
   * Remove every version of an object, delete markers included.
   * @param key The object key.
   * @throws {StorageError} When a failure is injected for `erase`.
   */
  async erase(key: string): Promise<void> {
    this.record('erase');
    this.objects.delete(key);
  }

  /**
   * Move the current version to the archive storage class, preserving bytes.
   * @param key The object key.
   * @throws {StorageError} When a failure is injected, or the object is absent —
   *         archiving something that is not there is a real fault, unlike
   *         deleting it.
   */
  async archive(key: string): Promise<void> {
    this.record('archive');
    const current = this.currentVersion(key);
    if (!current) {
      throw new StorageError('archive', false, new Error(`No such object: ${key}`));
    }
    current.storageClass = 'ARCHIVE';
  }

  /**
   * Always healthy — the mock has nothing to be unhealthy about, and CI must not
   * need a bucket (doc 09 §3).
   * @returns A healthy signal.
   */
  async health(): Promise<StorageHealth> {
    this.record('health');
    return { reachable: true, bucketExists: true, credentialsValid: true, latencyMs: 0 };
  }

  // ── Test and development affordances ───────────────────────────────────────

  /**
   * Place bytes at a key, as the client's direct PUT would.
   *
   * Not on {@link StorageProvider}: bytes never transit the API (R-FILE-1), so
   * no production caller may write an object. This exists because a test has to
   * stand in for the client.
   * @param key The object key.
   * @param body The bytes to store.
   * @param contentType The content-type the "client" declared.
   * @returns The new version id.
   */
  putObject(key: string, body: Buffer, contentType: string): string {
    const versionId = randomUUID();
    const versions = this.objects.get(key) ?? [];
    versions.push({
      versionId,
      body,
      contentType,
      isDeleteMarker: false,
      storageClass: 'STANDARD',
    });
    this.objects.set(key, versions);
    return versionId;
  }

  /**
   * Every version ever written for a key, oldest first, including delete markers.
   *
   * The erase test asserts this is empty after `erase()` and **non-empty** after
   * `delete()` — without that contrast, the test would pass against a mock that
   * did not model versioning at all.
   * @param key The object key.
   * @returns The version ids.
   */
  versionIds(key: string): string[] {
    return (this.objects.get(key) ?? []).map((version) => version.versionId);
  }

  /**
   * Whether the current version has been archived.
   * @param key The object key.
   * @returns `true` when the newest non-marker version is in the archive class.
   */
  isArchived(key: string): boolean {
    return this.currentVersion(key)?.storageClass === 'ARCHIVE';
  }

  /**
   * Present a previously minted URL back to the mock, as a client would.
   *
   * This is what makes the mock's signatures meaningful: a URL is accepted only
   * if the HMAC re-derives, the clock has not passed its expiry, and the method
   * and content-type match what was signed.
   * @param url The URL to check.
   * @param presented How the caller is using it — method, and for uploads the
   *        content-type and byte count being written.
   * @returns Acceptance with the key, or the specific reason for refusal.
   */
  verifyUrl(
    url: string,
    presented: { method: string; contentType?: string; sizeBytes?: number },
  ): MockUrlVerdict {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    const key = decodeURIComponent(parsed.pathname.slice(1));
    const method = parsed.searchParams.get('method');
    const expires = parsed.searchParams.get('expires');
    const signature = parsed.searchParams.get('sig');
    if (!method || !expires || !signature) return { ok: false, reason: 'malformed' };

    const extras: Record<string, string> = {};
    for (const [name, value] of parsed.searchParams) {
      if (name !== 'method' && name !== 'expires' && name !== 'sig') extras[name] = value;
    }

    const expected = this.signature(method, key, new Date(Number(expires)), extras);
    if (expected !== signature) return { ok: false, reason: 'bad-signature' };
    if (this.now().getTime() > Number(expires)) return { ok: false, reason: 'expired' };
    if (presented.method !== method) return { ok: false, reason: 'wrong-method' };

    const boundContentType = extras.ct;
    if (
      presented.contentType !== undefined &&
      boundContentType !== undefined &&
      presented.contentType !== boundContentType
    ) {
      return { ok: false, reason: 'wrong-content-type' };
    }

    const boundMax = extras.max;
    if (presented.sizeBytes !== undefined && boundMax !== undefined) {
      if (presented.sizeBytes > Number(boundMax)) return { ok: false, reason: 'too-large' };
    }

    return { ok: true, key };
  }

  /**
   * Fail the next `count` calls to `operation`.
   * @param operation Which contract method to fail.
   * @param retryable The flag the thrown {@link StorageError} carries.
   * @param count How many calls to fail; defaults to one.
   */
  failNext(operation: StorageOperation, retryable = true, count = 1): void {
    this.failures.set(operation, { retryable, remaining: count });
  }

  /** Clear every injected failure. */
  clearFailures(): void {
    this.failures.clear();
  }

  /** Replace the clock, to move past a TTL without touching timers. */
  setClock(now: () => Date): void {
    this.now = now;
  }

  /** Forget every object and every call count. */
  reset(): void {
    this.objects.clear();
    this.failures.clear();
    this.setClock(() => new Date());
    for (const operation of Object.keys(this.calls) as StorageOperation[]) {
      this.calls[operation] = 0;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Count the call and throw if a failure is queued for this operation. */
  private record(operation: StorageOperation): void {
    this.calls[operation] += 1;
    const failure = this.failures.get(operation);
    if (!failure) return;
    failure.remaining -= 1;
    if (failure.remaining <= 0) this.failures.delete(operation);
    throw new StorageError(operation, failure.retryable, new Error('injected mock failure'));
  }

  /** The newest version, or `null` when absent or hidden by a delete marker. */
  private currentVersion(key: string): MockVersion | null {
    const versions = this.objects.get(key);
    if (!versions || versions.length === 0) return null;
    const newest = versions[versions.length - 1];
    if (!newest || newest.isDeleteMarker) return null;
    return newest;
  }

  /** Build a signed URL binding method, key, expiry, and the extra parameters. */
  private sign(
    method: string,
    key: string,
    expiresAt: Date,
    extras: Record<string, string>,
  ): string {
    const url = new URL(`${MOCK_HOST}/${encodeURIComponent(key)}`);
    url.searchParams.set('method', method);
    url.searchParams.set('expires', String(expiresAt.getTime()));
    for (const [name, value] of Object.entries(extras)) url.searchParams.set(name, value);
    url.searchParams.set('sig', this.signature(method, key, expiresAt, extras));
    return url.toString();
  }

  /** HMAC over everything the signature is meant to bind. */
  private signature(
    method: string,
    key: string,
    expiresAt: Date,
    extras: Record<string, string>,
  ): string {
    const canonical = [
      method,
      key,
      String(expiresAt.getTime()),
      ...Object.entries(extras)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${value}`),
    ].join('\n');
    return createHmac('sha256', MOCK_SIGNING_KEY).update(canonical).digest('hex');
  }
}
