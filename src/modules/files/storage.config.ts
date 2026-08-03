import { config } from '@config';
import { MockStorageProvider } from './providers/mock.provider.js';
import { S3StorageProvider } from './providers/s3.provider.js';
import type { StorageProvider } from './providers/storage.provider.js';

/** The storage backends this module can select (files doc 07 §5, FILES-OD-12). */
export type StorageProviderName = 'mock' | 's3';

/**
 * Server-side encryption modes (files doc 08 §2, Security 03 §42).
 *
 * A closed set because the value reaches S3 verbatim: an unrecognised string
 * would be rejected on every upload at runtime, and the deploy that set it should
 * fail instead (doc 08 §7).
 */
const ENCRYPTION_MODES = ['AES256', 'aws:kms', 'aws:kms:dsse'] as const;
export type ServerSideEncryptionMode = (typeof ENCRYPTION_MODES)[number];

/**
 * Read `STORAGE_SSE`, refusing anything unrecognised.
 *
 * Unset falls back to `AES256` and **never to none** (doc 08 §7). A typo does
 * not: `aws-kms` for `aws:kms` would silently store compliance evidence under
 * S3-managed keys rather than the KMS key someone was asked to sign off on.
 * @returns The validated mode.
 * @throws Error when the value is set but not a mode S3 accepts.
 */
function readEncryptionMode(): ServerSideEncryptionMode {
  const raw = process.env.STORAGE_SSE;
  if (raw == null || raw === '') return 'AES256';
  if ((ENCRYPTION_MODES as readonly string[]).includes(raw)) {
    return raw as ServerSideEncryptionMode;
  }
  throw new Error(`STORAGE_SSE must be one of ${ENCRYPTION_MODES.join(', ')} (files doc 08 §2)`);
}

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
  serverSideEncryption: ServerSideEncryptionMode;
  kmsKeyId: string | null;
  /** The write-permission window. Global, not per purpose (doc 02 §5). */
  uploadUrlTtlSeconds: number;
  /** Leading bytes fetched by `head` — enough for every signature in doc 02 §5. */
  peekBytes: number;
  /**
   * Leading bytes fetched for an **image**, where the header must also yield
   * dimensions (R-FILE-35).
   *
   * A signature needs a handful of bytes. A JPEG's start-of-frame marker sits
   * after every APP segment that precedes it — a 64 KB EXIF block, ICC profiles,
   * an embedded thumbnail — so `peekBytes` is nowhere near enough, and failing
   * closed on "dimensions unreadable" with a 512-byte peek would reject ordinary
   * camera photographs.
   */
  imagePeekBytes: number;
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
    serverSideEncryption: readEncryptionMode(),
    kmsKeyId: process.env.STORAGE_KMS_KEY_ID ?? null,
    uploadUrlTtlSeconds: Number(process.env.STORAGE_UPLOAD_TTL_SEC ?? 900),
    peekBytes: Number(process.env.STORAGE_PEEK_BYTES ?? 512),
    imagePeekBytes: Number(process.env.STORAGE_IMAGE_PEEK_BYTES ?? 131072),
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
 * This function is the whole of acceptance criterion #10: swapping backends is
 * `STORAGE_PROVIDER=s3` and nothing else. No caller names a provider class, and
 * nothing above {@link StorageProvider} knows which one answered.
 * @param storageConfig Resolved storage configuration.
 * @returns The chosen provider instance.
 * @throws Error when `s3` is selected without a bucket.
 */
export function createStorageProvider(storageConfig: StorageConfig): StorageProvider {
  if (storageConfig.provider === 's3') {
    if (!storageConfig.bucket) {
      throw new Error('STORAGE_BUCKET is required when STORAGE_PROVIDER=s3 (files doc 08 §7)');
    }
    return new S3StorageProvider(storageConfig);
  }
  return new MockStorageProvider();
}
