import { config } from '@config';
import { MockStorageProvider } from '../utils/storage/mock.provider.js';
import { S3StorageProvider } from '../utils/storage/s3.provider.js';
import type { StorageProvider } from '../utils/storage/storage.provider.js';
export type StorageProviderName = 'mock' | 's3';
const ENCRYPTION_MODES = ['AES256', 'aws:kms', 'aws:kms:dsse'] as const;
export type ServerSideEncryptionMode = (typeof ENCRYPTION_MODES)[number];
function readEncryptionMode(): ServerSideEncryptionMode {
  const raw = process.env.STORAGE_SSE;
  if (raw == null || raw === '') return 'AES256';
  if ((ENCRYPTION_MODES as readonly string[]).includes(raw)) {
    return raw as ServerSideEncryptionMode;
  }
  throw new Error(`STORAGE_SSE must be one of ${ENCRYPTION_MODES.join(', ')} (files doc 08 §2)`);
}
export type MalwareScannerName = 'guardduty' | 'disabled';
export interface StorageConfig {
  provider: StorageProviderName;
  bucket: string | null;
  quarantineBucket: string | null;
  scanner: MalwareScannerName;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  } | null;
  serverSideEncryption: ServerSideEncryptionMode;
  kmsKeyId: string | null;
  uploadUrlTtlSeconds: number;
  peekBytes: number;
  imagePeekBytes: number;
  requestTimeoutMs: number;
  maxRetries: number;
}
function readScanner(environment: string): MalwareScannerName {
  const raw = process.env.STORAGE_MALWARE_SCANNER;
  const servesRealUsers = environment === 'production' || environment === 'staging';
  const scanner: MalwareScannerName =
    raw === 'disabled' || raw === 'guardduty'
      ? raw
      : raw == null || raw === ''
        ? servesRealUsers
          ? 'guardduty'
          : 'disabled'
        : (() => {
            throw new Error("STORAGE_MALWARE_SCANNER must be 'guardduty' or 'disabled'");
          })();
  if (scanner === 'disabled' && servesRealUsers) {
    throw new Error(
      `STORAGE_MALWARE_SCANNER=disabled is not permitted in ${environment}. ` +
        'Enrol the quarantine bucket in GuardDuty Malware Protection for S3.',
    );
  }
  return scanner;
}
function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value == null || value === '' ? null : value;
}
export function getStorageConfig(): StorageConfig {
  const explicit = process.env.STORAGE_PROVIDER as StorageProviderName | undefined;
  const environment = config.app.environment;
  const provider: StorageProviderName =
    explicit ?? (environment === 'production' || environment === 'staging' ? 's3' : 'mock');
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  return {
    provider,
    bucket: optionalEnv('STORAGE_BUCKET'),
    quarantineBucket: optionalEnv('STORAGE_QUARANTINE_BUCKET'),
    scanner: readScanner(environment),
    region: optionalEnv('STORAGE_REGION') ?? 'ap-south-1',
    endpoint: optionalEnv('STORAGE_ENDPOINT'),
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null,
    serverSideEncryption: readEncryptionMode(),
    kmsKeyId: optionalEnv('STORAGE_KMS_KEY_ID'),
    uploadUrlTtlSeconds: Number(process.env.STORAGE_UPLOAD_TTL_SEC ?? 900),
    peekBytes: Number(process.env.STORAGE_PEEK_BYTES ?? 512),
    imagePeekBytes: Number(process.env.STORAGE_IMAGE_PEEK_BYTES ?? 131072),
    requestTimeoutMs: Number(process.env.STORAGE_TIMEOUT_MS ?? 5000),
    maxRetries: Number(process.env.STORAGE_MAX_RETRIES ?? 2),
  };
}
export function createStorageProvider(storageConfig: StorageConfig): StorageProvider {
  if (storageConfig.provider === 's3') {
    if (!storageConfig.bucket) {
      throw new Error('STORAGE_BUCKET is required when STORAGE_PROVIDER=s3 (files doc 08 \u00A77)');
    }
    if (!storageConfig.quarantineBucket) {
      throw new Error(
        'STORAGE_QUARANTINE_BUCKET is required when STORAGE_PROVIDER=s3. Uploads land there ' +
          'until they are scanned and validated; without it an unscanned object would be ' +
          'written straight into the bucket reads are served from.',
      );
    }
    if (storageConfig.quarantineBucket === storageConfig.bucket) {
      throw new Error(
        'STORAGE_QUARANTINE_BUCKET must differ from STORAGE_BUCKET \u2014 the separation is what ' +
          'stops an unscanned object being readable.',
      );
    }
    if (storageConfig.scanner === 'guardduty' && storageConfig.serverSideEncryption === 'AES256') {
      throw new Error(
        'STORAGE_SSE must be aws:kms when GuardDuty Malware Protection is enabled, and ' +
          'STORAGE_KMS_KEY_ID must name the dedicated key.',
      );
    }
    if (storageConfig.serverSideEncryption !== 'AES256' && !storageConfig.kmsKeyId) {
      throw new Error('STORAGE_KMS_KEY_ID is required when STORAGE_SSE is a KMS mode');
    }
    return new S3StorageProvider(storageConfig);
  }
  return new MockStorageProvider();
}
