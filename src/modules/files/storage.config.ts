import { config } from '@config';
import { MockStorageProvider } from './providers/mock.provider.js';
import type { StorageProvider } from './providers/storage.provider.js';

/** The storage backends this module can select (files doc 07 §5, FILES-OD-12). */
export type StorageProviderName = 'mock' | 's3';

/**
 * Infrastructure settings for object storage (files doc 08 §2).
 *
 * Separate from `fileConfig` on purpose: policy is reviewed by product and
 * compliance, infrastructure by whoever holds the cloud account (doc 08 §1).
 * `notifications` splits the same way.
 */
export interface StorageConfig {
  provider: StorageProviderName;
  /** The only bucket, and it is private. There is no public bucket (doc 08 §2.1). */
  bucket: string | null;
  region: string;
  /** Set for MinIO / R2 / Spaces — they are `s3` with a different endpoint. */
  endpoint: string | null;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string } | null;
  serverSideEncryption: string;
  kmsKeyId: string | null;
  /** The write-permission window. Global, not per purpose (doc 02 §5). */
  uploadUrlTtlSeconds: number;
  /** Leading bytes fetched by `head` — enough for every signature in doc 02 §5. */
  peekBytes: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

/**
 * Build the storage configuration from the environment.
 *
 * The provider defaults to `mock` in development and test and `s3` in staging
 * and production, overridable with `STORAGE_PROVIDER` — the same defaulting rule
 * `SMS_PROVIDER` uses.
 * @returns The resolved configuration.
 */
export function getStorageConfig(): StorageConfig {
  const explicit = process.env.STORAGE_PROVIDER as StorageProviderName | undefined;
  const environment = config.app.environment;
  const provider: StorageProviderName =
    explicit ?? (environment === 'production' || environment === 'staging' ? 's3' : 'mock');

  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;

  return {
    provider,
    bucket: process.env.STORAGE_BUCKET ?? null,
    region: process.env.STORAGE_REGION ?? 'ap-south-1',
    endpoint: process.env.STORAGE_ENDPOINT ?? null,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null,
    // Never falls back to no encryption (doc 08 §7).
    serverSideEncryption: process.env.STORAGE_SSE ?? 'AES256',
    kmsKeyId: process.env.STORAGE_KMS_KEY_ID ?? null,
    uploadUrlTtlSeconds: Number(process.env.STORAGE_UPLOAD_TTL_SEC ?? 900),
    peekBytes: Number(process.env.STORAGE_PEEK_BYTES ?? 512),
    requestTimeoutMs: Number(process.env.STORAGE_TIMEOUT_MS ?? 5000),
    maxRetries: Number(process.env.STORAGE_MAX_RETRIES ?? 2),
  };
}

/**
 * Provider factory — selects the concrete {@link StorageProvider} from config.
 *
 * **Fails at boot**, not per request, when `s3` is selected without a bucket:
 * a `files` module with no bucket has no work it can do, and failing fast turns
 * a subtle production outage into an obvious deploy failure (doc 08 §7).
 *
 * The `s3` provider arrives in phase 5; selecting it before then is a
 * configuration error rather than a silent fallback to `mock`, because falling
 * back would put a production deploy on an in-memory store.
 * @param storageConfig Resolved storage configuration.
 * @returns The chosen provider instance.
 * @throws Error when `s3` is selected — before phase 5, or without a bucket.
 */
export function createStorageProvider(storageConfig: StorageConfig): StorageProvider {
  if (storageConfig.provider === 's3') {
    if (!storageConfig.bucket) {
      throw new Error('STORAGE_BUCKET is required when STORAGE_PROVIDER=s3 (files doc 08 §7)');
    }
    throw new Error(
      'Storage provider "s3" is not implemented until FILES phase 5. Refusing to fall back ' +
        'to the in-memory mock, which would silently put a deploy on non-durable storage.',
    );
  }
  return new MockStorageProvider();
}
