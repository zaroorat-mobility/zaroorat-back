import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig, type FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from './repositories/file.repository.js';
import { FileMetrics } from './file.metrics.js';
import { fileEvent } from './events/catalog.js';
import { buildStorageKey } from './storage-key.js';
import { inspect } from './content-inspector.js';
import {
  assertDeclaredUploadAllowed,
  assertStoredObjectAllowed,
  peekBudgetFor,
  policyFor,
  sanitizeFileName,
} from './file.policy.js';
import {
  ChecksumMismatchError,
  ContentMismatchError,
  FileNotFoundError,
  FileStateError,
  FileTooLargeError,
  UploadExpiredError,
  UploadNotFoundError,
} from './errors.js';
import { RateLimitedError } from '@modules/auth/errors';
import type { StorageConfig } from './storage.config.js';
import type { StorageProvider } from './providers/storage.provider.js';

/** What a client declares when asking for a write permission (doc 02 §2.1). */
export interface CreateUploadInput {
  ownerUserId: string;
  purpose: FilePurposeName;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  requestId?: string | null;
}

/** The `201` body of `POST /files` (doc 02 §2.1). */
export interface CreateUploadResult {
  fileId: string;
  status: 'PENDING';
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: Date;
  };
}

/** The `200` body of `POST /files/{id}/complete` (doc 02 §2.2). */
export interface CompleteUploadResult {
  fileId: string;
  status: 'READY';
  purpose: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  createdAt: Date;
}

/**
 * The upload pair (files doc 01 §12 phase 2, doc 02 §2.1–§2.2).
 *
 * **No byte passes through this service.** The client PUTs directly to storage
 * using a permission scoped to one key, one method, one content-type, and one
 * size ceiling (R-FILE-1, R-FILE-2). What happens here is validation before the
 * permission is issued, and validation of what actually arrived afterwards.
 */
export class FileService {
  /**
   * @param fileRepository Data access for `files`.
   * @param storageProvider The configured storage backend.
   * @param storageConfig Bucket, TTLs, and peek budgets.
   * @param transactionManager Unit of work for the `READY` transition.
   * @param eventPublisher Outbox writer.
   * @param redisService Rate limiting and stored-response idempotency.
   * @param fileMetrics Upload counters.
   */
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly storageConfig: StorageConfig,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

  /**
   * Reserve a file and mint a write permission (doc 02 §2.1).
   *
   * Ordering is R-FILE-26 and is the recoverable one: validate, write the
   * `PENDING` row, **then** sign. If signing fails after the row exists the
   * sweeper reclaims a reservation that never received bytes. The reverse order
   * would leave a client holding a valid permission for a key nothing knows
   * about — an object nobody can find, delete, or bill for.
   *
   * @param input The declared purpose, name, type, and size.
   * @returns The file id and its scoped upload permission.
   * @throws {UnsupportedMediaTypeError} Type not permitted for the purpose.
   * @throws {FileTooLargeError} Declared size over the ceiling, or over quota.
   * @throws {RateLimitedError} A per-user or per-purpose limit was hit.
   */
  async createUpload(input: CreateUploadInput): Promise<CreateUploadResult> {
    assertDeclaredUploadAllowed(input.purpose, input.contentType, input.sizeBytes);
    await this.assertWithinLimits(input.ownerUserId, input.purpose, input.sizeBytes);

    const policy = policyFor(input.purpose);
    const storageKey = buildStorageKey(input.purpose, input.contentType);
    const uploadExpiresAt = new Date(Date.now() + this.storageConfig.uploadUrlTtlSeconds * 1000);

    const file = await this.fileRepository.create({
      ownerUserId: input.ownerUserId,
      purpose: input.purpose,
      storageKey,
      storageProvider: this.storageProvider.name,
      fileName: sanitizeFileName(input.fileName, input.contentType),
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadExpiresAt,
      ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
    });

    const signed = await this.storageProvider.signUpload({
      key: storageKey,
      contentType: input.contentType,
      maxBytes: policy.maxBytes,
      ttlSeconds: this.storageConfig.uploadUrlTtlSeconds,
      ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
    });

    this.fileMetrics.uploadRequested({ purpose: input.purpose });

    return {
      fileId: file.id,
      status: 'PENDING',
      upload: {
        method: signed.method,
        url: signed.url,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      },
    };
  }

  /**
   * Verify the stored bytes and publish the file (doc 02 §2.2).
   *
   * Checks run cheapest-first, each a hard gate: real size, then declared type
   * against magic bytes, then decoded pixel count, then checksum. Nothing
   * expensive runs until everything cheap has passed.
   *
   * On any content failure the object is **deleted** and the row marked
   * `EXPIRED` — a reservation whose bytes were refused must not linger as
   * something a retry could complete.
   *
   * @param fileId The reserved file.
   * @param ownerUserId The caller, applied in the query's `WHERE` clause.
   * @param requestId Correlation id for the event envelope.
   * @returns The published file.
   * @throws {FileNotFoundError} No such file, or not the caller's.
   * @throws {FileStateError} The file is not awaiting completion.
   * @throws {UploadExpiredError} The permission window closed.
   * @throws {UploadNotFoundError} No object is at the key yet.
   * @throws {ContentMismatchError} The bytes are not the declared type.
   * @throws {ChecksumMismatchError} The declared digest does not match.
   * @throws {FileTooLargeError} The real size or pixel count is over the ceiling.
   */
  async completeUpload(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<CompleteUploadResult> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId);
    if (!file) throw new FileNotFoundError();

    // Idempotent without a key: completing an already-READY file returns the
    // same body and emits nothing further (doc 02 §2.2).
    if (file.status === 'READY') return this.toResult(file);
    if (file.status !== 'PENDING') {
      throw new FileStateError('That file is not awaiting completion');
    }
    if (file.uploadExpiresAt.getTime() <= Date.now()) {
      await this.rejectUpload(file.id, file.storageKey, file.purpose, 'UPLOAD_EXPIRED');
      throw new UploadExpiredError();
    }

    const purpose = file.purpose as FilePurposeName;
    const peekBytes = peekBudgetFor(
      file.contentType,
      this.storageConfig.peekBytes,
      this.storageConfig.imagePeekBytes,
    );

    const head = await this.storageProvider.head(file.storageKey, peekBytes);
    if (!head) {
      // Recoverable: the row stays PENDING so the client can re-PUT and retry.
      this.fileMetrics.uploadRejected({ purpose, reason: 'UPLOAD_NOT_FOUND' });
      throw new UploadNotFoundError();
    }

    await this.verifyStoredObject(file.id, file.storageKey, purpose, file, head);

    const inspection = inspect(file.contentType, head.peek);
    if (!inspection.ok) {
      await this.rejectUpload(file.id, file.storageKey, purpose, 'CONTENT_MISMATCH');
      throw new ContentMismatchError();
    }
    try {
      assertStoredObjectAllowed(purpose, file.contentType, head.sizeBytes, inspection.dimensions);
    } catch (error) {
      await this.rejectUpload(file.id, file.storageKey, purpose, 'FILE_TOO_LARGE');
      throw error;
    }

    const completedAt = new Date();
    const transitioned = await this.transactionManager.execute(async (tx) => {
      const won = await this.fileRepository.markReady(
        file.id,
        {
          sizeBytes: head.sizeBytes,
          completedAt,
          ...(head.checksumSha256 != null ? { checksumSha256: head.checksumSha256 } : {}),
        },
        tx,
      );
      // FILE-INV-6: of two concurrent completions exactly one transitions, and
      // only the winner writes the event — so exactly one `file.uploaded` exists.
      if (!won) return false;

      await this.eventPublisher.publish(
        fileEvent('file.uploaded', {
          aggregateId: file.id,
          subjectUserId: ownerUserId,
          requestId,
          data: {
            fileId: file.id,
            ownerUserId,
            purpose,
            contentType: file.contentType,
            sizeBytes: head.sizeBytes,
          },
        }),
        tx,
      );
      return true;
    });

    if (!transitioned) {
      // The other caller won. Return its result rather than an error: from the
      // client's side this retry succeeded, which is what idempotency means.
      const settled = await this.fileRepository.findOwned(fileId, ownerUserId);
      if (!settled) throw new FileNotFoundError();
      return this.toResult(settled);
    }

    this.fileMetrics.uploadCompleted({ purpose, sizeBytes: head.sizeBytes });
    this.fileMetrics.uploadDuration({
      purpose,
      ms: completedAt.getTime() - file.createdAt.getTime(),
    });

    return this.toResult({
      id: file.id,
      purpose: file.purpose,
      contentType: file.contentType,
      createdAt: file.createdAt,
      sizeBytes: head.sizeBytes,
      checksumSha256: head.checksumSha256 ?? file.checksumSha256,
    });
  }

  /**
   * Compare the stored object against the declared checksum.
   *
   * Separate from the type and size gates because its remedy differs: a corrupt
   * transfer is worth retrying, a wrong file is not (doc 04 §3).
   */
  private async verifyStoredObject(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
    file: { checksumSha256: string | null },
    head: { checksumSha256: string | null },
  ): Promise<void> {
    if (
      file.checksumSha256 != null &&
      head.checksumSha256 != null &&
      file.checksumSha256 !== head.checksumSha256
    ) {
      await this.rejectUpload(fileId, storageKey, purpose, 'CHECKSUM_MISMATCH');
      throw new ChecksumMismatchError();
    }
  }

  /**
   * Remove a refused object and retire its reservation.
   *
   * Best-effort on the storage side: if the delete fails the sweeper collects
   * the object later, and failing the request because cleanup failed would tell
   * the client to retry something that is already correctly refused.
   */
  private async rejectUpload(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
    reason: string,
  ): Promise<void> {
    this.fileMetrics.uploadRejected({ purpose, reason });
    try {
      await this.storageProvider.delete(storageKey);
    } catch (err) {
      logger.warn({ err, fileId }, '[Files] failed to remove a refused object');
    }
    await this.fileRepository.markExpired(fileId);
  }

  /**
   * Enforce the request-rate limits and the byte quotas (R-FILE-9, R-FILE-30).
   *
   * Both, because they bound different things: a rate limit bounds requests, and
   * thirty 50 MB clips an hour is inside the rate limit and is 1.5 GB
   * (FILES-OD-11).
   */
  private async assertWithinLimits(
    ownerUserId: string,
    purpose: FilePurposeName,
    sizeBytes: number,
  ): Promise<void> {
    const perUser = await this.redisService.rateLimit.hit(
      'file:upload:user',
      ownerUserId,
      fileConfig.uploadsPerUserPerHour,
      3600,
    );
    if (!perUser.allowed) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'user' });
      throw new RateLimitedError(perUser.retryAfterSeconds);
    }

    const perPurpose = await this.redisService.rateLimit.hit(
      'file:upload:purpose',
      `${ownerUserId}:${purpose}`,
      fileConfig.uploadsPerPurposePerHour,
      3600,
    );
    if (!perPurpose.allowed) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'purpose' });
      throw new RateLimitedError(perPurpose.retryAfterSeconds);
    }

    // Quotas are checked before signing, so an over-quota upload never creates
    // an object (doc 08 §5).
    const [userBytes, purposeBytes] = await Promise.all([
      this.fileRepository.totalBytesForUser(ownerUserId),
      this.fileRepository.totalBytesForUser(ownerUserId, purpose),
    ]);

    if (userBytes + sizeBytes > fileConfig.maxTotalBytesPerUser) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'quota_user' });
      throw new FileTooLargeError('sizeBytes', fileConfig.maxTotalBytesPerUser);
    }
    if (purposeBytes + sizeBytes > fileConfig.maxTotalBytesPerPurpose) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'quota_purpose' });
      throw new FileTooLargeError('sizeBytes', fileConfig.maxTotalBytesPerPurpose);
    }
  }

  /** Render a row as the doc 02 §2.2 response body. */
  private toResult(file: {
    id: string;
    purpose: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string | null;
    createdAt: Date;
  }): CompleteUploadResult {
    return {
      fileId: file.id,
      status: 'READY',
      purpose: file.purpose,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      createdAt: file.createdAt,
    };
  }
}
