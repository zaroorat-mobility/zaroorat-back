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

const MOCK_HOST = 'https://mock-storage.local';

const MOCK_SIGNING_KEY = 'mock-storage-signing-key';

interface MockVersion {
  versionId: string;
  body: Buffer;
  contentType: string;
  isDeleteMarker: boolean;
  storageClass: 'STANDARD' | 'ARCHIVE';
}

interface InjectedFailure {
  retryable: boolean;
  remaining: number;
}

export type MockUrlRejection =
  'malformed' | 'bad-signature' | 'expired' | 'wrong-method' | 'wrong-content-type' | 'too-large';

export type MockUrlVerdict = { ok: true; key: string } | { ok: false; reason: MockUrlRejection };

export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock';

  private readonly objects = new Map<string, MockVersion[]>();

  private readonly failures = new Map<StorageOperation, InjectedFailure>();

  readonly calls: Record<StorageOperation, number> = {
    signUpload: 0,
    signDownload: 0,
    head: 0,
    promote: 0,
    delete: 0,
    erase: 0,
    archive: 0,
    health: 0,
  };

  constructor(private now: () => Date = () => new Date()) {}

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

  async signDownload(input: SignDownloadInput): Promise<SignedDownload> {
    this.record('signDownload');
    const expiresAt = new Date(this.now().getTime() + input.ttlSeconds * 1000);
    const url = this.sign('GET', input.key, expiresAt, {
      ct: input.contentType,
      disp: input.disposition,
    });
    return { url, expiresAt };
  }

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

  async promote(key: string): Promise<void> {
    this.record('promote');
    const current = this.currentVersion(key);
    if (!current) {
      throw new StorageError('promote', false, new Error(`No such object: ${key}`));
    }
    // Mock promote just leaves it in standard class or does nothing.
  }

  async delete(key: string): Promise<void> {
    this.record('delete');
    const versions = this.objects.get(key);
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

  async erase(key: string): Promise<void> {
    this.record('erase');
    this.objects.delete(key);
  }

  async archive(key: string): Promise<void> {
    this.record('archive');
    const current = this.currentVersion(key);
    if (!current) {
      throw new StorageError('archive', false, new Error(`No such object: ${key}`));
    }
    current.storageClass = 'ARCHIVE';
  }

  async health(): Promise<StorageHealth> {
    this.record('health');
    return { reachable: true, bucketExists: true, credentialsValid: true, latencyMs: 0 };
  }

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

  versionIds(key: string): string[] {
    return (this.objects.get(key) ?? []).map((version) => version.versionId);
  }

  isArchived(key: string): boolean {
    return this.currentVersion(key)?.storageClass === 'ARCHIVE';
  }

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

  failNext(operation: StorageOperation, retryable = true, count = 1): void {
    this.failures.set(operation, { retryable, remaining: count });
  }

  clearFailures(): void {
    this.failures.clear();
  }

  setClock(now: () => Date): void {
    this.now = now;
  }

  reset(): void {
    this.objects.clear();
    this.failures.clear();
    this.setClock(() => new Date());
    for (const operation of Object.keys(this.calls) as StorageOperation[]) {
      this.calls[operation] = 0;
    }
  }

  private record(operation: StorageOperation): void {
    this.calls[operation] += 1;
    const failure = this.failures.get(operation);
    if (!failure) return;
    failure.remaining -= 1;
    if (failure.remaining <= 0) this.failures.delete(operation);
    throw new StorageError(operation, failure.retryable, new Error('injected mock failure'));
  }

  private currentVersion(key: string): MockVersion | null {
    const versions = this.objects.get(key);
    if (!versions || versions.length === 0) return null;
    const newest = versions[versions.length - 1];
    if (!newest || newest.isDeleteMarker) return null;
    return newest;
  }

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
