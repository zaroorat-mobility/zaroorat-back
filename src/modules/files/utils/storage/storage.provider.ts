export type StorageArea = 'quarantine' | 'trusted';
export interface SignUploadInput {
  key: string;
  contentType: string;
  contentLength: number;
  ttlSeconds: number;
  checksumSha256?: string;
}
export interface SignedUpload {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}
export interface SignDownloadInput {
  key: string;
  ttlSeconds: number;
  contentType: string;
  disposition: 'inline' | 'attachment';
  fileName: string;
}
export interface SignedDownload {
  url: string;
  expiresAt: Date;
}
export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
  checksumSha256: string | null;
  peek: Buffer;
  versionId: string | null;
}
export interface StorageHealth {
  reachable: boolean;
  bucketExists: boolean;
  credentialsValid: boolean;
  latencyMs: number;
}
export type StorageOperation =
  'signUpload' | 'signDownload' | 'head' | 'promote' | 'delete' | 'erase' | 'archive' | 'health';
export class StorageError extends Error {
  constructor(
    readonly operation: StorageOperation,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(`Storage operation "${operation}" failed`);
    this.name = 'StorageError';
  }
}
export interface StorageProvider {
  readonly name: string;
  signUpload(input: SignUploadInput): Promise<SignedUpload>;
  signDownload(input: SignDownloadInput): Promise<SignedDownload>;
  head(key: string, peekBytes: number, area?: StorageArea): Promise<ObjectHead | null>;
  promote(key: string): Promise<void>;
  delete(key: string, area?: StorageArea): Promise<void>;
  erase(key: string, area?: StorageArea): Promise<void>;
  archive(key: string): Promise<void>;
  health(): Promise<StorageHealth>;
}
