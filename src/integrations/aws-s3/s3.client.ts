import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from '../../modules/files/config/storage.config.js';
import type {
  ObjectHead,
  SignDownloadInput,
  SignUploadInput,
  SignedDownload,
  SignedUpload,
  StorageHealth,
  StorageArea,
  StorageOperation,
  StorageProvider,
} from '../../modules/files/utils/storage/storage.provider.js';
import { StorageError } from '../../modules/files/utils/storage/storage.provider.js';
import { base64ToHex, hexToBase64 } from '../../modules/files/utils/checksum.js';
const ARCHIVE_STORAGE_CLASS = 'GLACIER_IR';
const DELETE_BATCH_SIZE = 1000;
function isRetryable(error: unknown): boolean {
  const status = (
    error as {
      $metadata?: {
        httpStatusCode?: number;
      };
    }
  )?.$metadata?.httpStatusCode;
  if (typeof status === 'number') return status >= 500 || status === 429;
  return true;
}
function isNotFound(error: unknown): boolean {
  const name = (
    error as {
      name?: string;
    }
  )?.name;
  const status = (
    error as {
      $metadata?: {
        httpStatusCode?: number;
      };
    }
  )?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
function buildClient(storageConfig: StorageConfig): S3Client {
  return new S3Client({
    region: storageConfig.region,
    ...(storageConfig.endpoint != null ? { endpoint: storageConfig.endpoint } : {}),
    forcePathStyle: storageConfig.forcePathStyle,
    ...(storageConfig.credentials != null ? { credentials: storageConfig.credentials } : {}),
    maxAttempts: storageConfig.maxRetries + 1,
    requestHandler: {
      requestTimeout: storageConfig.requestTimeoutMs,
      connectionTimeout: storageConfig.requestTimeoutMs,
    },
  });
}
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly bucket: string;
  private readonly quarantineBucket: string;
  constructor(
    private readonly storageConfig: StorageConfig,
    private readonly client: S3Client = buildClient(storageConfig),
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!storageConfig.bucket) {
      throw new Error('STORAGE_BUCKET is required when STORAGE_PROVIDER=s3 (files doc 08 \u00A77)');
    }
    this.bucket = storageConfig.bucket;
    this.quarantineBucket = storageConfig.quarantineBucket ?? storageConfig.bucket;
  }
  private bucketFor(area: StorageArea): string {
    return area === 'quarantine' ? this.quarantineBucket : this.bucket;
  }
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
          Bucket: this.quarantineBucket,
          Key: input.key,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
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
          signableHeaders: new Set(['content-type', 'content-length']),
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
  async head(
    key: string,
    peekBytes: number,
    area: StorageArea = 'trusted',
  ): Promise<ObjectHead | null> {
    const Bucket = this.bucketFor(area);
    let metadata;
    try {
      metadata = await this.client.send(
        new HeadObjectCommand({ Bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw this.wrap('head', error);
    }
    let peek = Buffer.alloc(0);
    if (peekBytes > 0 && (metadata.ContentLength ?? 0) > 0) {
      try {
        const window = await this.client.send(
          new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${peekBytes - 1}` }),
        );
        peek = Buffer.from((await window.Body?.transformToByteArray()) ?? []);
      } catch (error) {
        if (!isNotFound(error)) throw this.wrap('head', error);
        return null;
      }
    }
    return {
      sizeBytes: metadata.ContentLength ?? 0,
      contentType: metadata.ContentType ?? null,
      checksumSha256: base64ToHex(metadata.ChecksumSHA256),
      peek,
      versionId: metadata.VersionId ?? null,
    };
  }
  async promote(key: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: key,
          CopySource: `${this.quarantineBucket}/${encodeURIComponent(key)}`,
          MetadataDirective: 'COPY',
          ServerSideEncryption: this.storageConfig.serverSideEncryption,
          ...(this.storageConfig.kmsKeyId != null
            ? { SSEKMSKeyId: this.storageConfig.kmsKeyId }
            : {}),
        }),
      );
    } catch (error) {
      throw this.wrap('promote', error);
    }
    try {
      await this.delete(key, 'quarantine');
    } catch {
      // Best effort: the object is already promoted, and a quarantine copy that
      // will not delete is a stray file rather than a failed promotion.
    }
  }
  async delete(key: string, area: StorageArea = 'trusted'): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketFor(area), Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw this.wrap('delete', error);
    }
  }
  async erase(key: string, area: StorageArea = 'trusted'): Promise<void> {
    try {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      do {
        const listed = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucketFor(area),
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
              Bucket: this.bucketFor(area),
              Delete: { Objects: targets.slice(start, start + DELETE_BATCH_SIZE), Quiet: true },
            }),
          );
        }
        keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
        versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
      } while (keyMarker != null || versionIdMarker != null);
    } catch (error) {
      if (isNotFound(error)) return;
      throw this.wrap('erase', error);
    }
  }
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
      const status = (
        error as {
          $metadata?: {
            httpStatusCode?: number;
          };
        }
      )?.$metadata?.httpStatusCode;
      return {
        reachable: typeof status === 'number',
        bucketExists: status !== 404,
        credentialsValid: status !== 403 && status !== 401,
        latencyMs: this.now().getTime() - startedAt,
      };
    }
  }
  private wrap(operation: StorageOperation, error: unknown): StorageError {
    return new StorageError(operation, isRetryable(error), error);
  }
}
