import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig, type FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../metrics/file.metrics.js';
import { fileEvent } from '../events/catalog.js';
import { buildStorageKey } from '../utils/storage-key.js';
import { inspect } from '../utils/content-inspector.js';
import { decideRead } from '../policies/read-policy.js';
import {
  assertDeclaredUploadAllowed,
  assertStoredObjectAllowed,
  peekBudgetFor,
  policyFor,
  sanitizeFileName,
} from '../policies/file.policy.js';
import {
  ChecksumMismatchError,
  ContentMismatchError,
  ExifLocationError,
  FileInUseError,
  FileNotFoundError,
  FileStateError,
  FileTooLargeError,
  UploadExpiredError,
  UploadNotFoundError,
} from '../errors/file.errors.js';
import { findLiveReference } from '../references/file-references.js';
import { RateLimitedError } from '@modules/auth/errors';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { StorageConfig } from '../config/storage.config.js';
import type { StorageProvider } from '../providers/storage.provider.js';

export interface CreateUploadInput {
  ownerUserId: string;
  purpose: FilePurposeName;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  requestId?: string | null;
}

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

export interface CompleteUploadResult {
  fileId: string;
  status: 'READY';
  purpose: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  createdAt: Date;
}

export class FileService {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly storageConfig: StorageConfig,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

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

  async completeUpload(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<CompleteUploadResult> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId);
    if (!file) throw new FileNotFoundError();

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

    if (policyFor(purpose).rejectExifLocation && inspection.location !== 'ABSENT') {
      await this.rejectUpload(file.id, file.storageKey, purpose, 'EXIF_LOCATION_PRESENT');
      throw new ExifLocationError();
    }

    const completedAt = new Date();
    const transitioned = await this.publishReady(file, ownerUserId, head, completedAt, requestId);

    if (!transitioned) {
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

  async getReadUrl(
    fileId: string,
    caller: { userId: string; roles: readonly string[] },
    disposition: 'inline' | 'attachment' = 'inline',
    requestId: string | null = null,
  ): Promise<{ url: string; expiresAt: Date; contentType: string }> {
    const limit = await this.redisService.rateLimit.hit(
      'file:read',
      caller.userId,
      fileConfig.readUrlsPerUserPerMinute,
      60,
    );
    if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);

    const file = await this.loadReadable(fileId);
    const purpose = file.purpose as FilePurposeName;
    const grant = decideRead({ ownerUserId: file.ownerUserId, purpose }, caller);

    if (!grant.granted) {
      this.fileMetrics.readDenied({ purpose });
      throw new FileNotFoundError();
    }

    if (grant.actor === 'ops') {
      await this.transactionManager.execute(async (tx) => {
        await this.eventPublisher.publish(
          fileEvent('file.read', {
            aggregateId: file.id,
            subjectUserId: file.ownerUserId,
            requestId,
            data: {
              fileId: file.id,
              ownerUserId: file.ownerUserId,
              actorUserId: caller.userId,
              purpose,
              scope: grant.scope,
            },
          }),
          tx,
        );
      });
    }

    const signed = await this.storageProvider.signDownload({
      key: file.storageKey,
      ttlSeconds: policyFor(purpose).readTtlSeconds,
      contentType: file.contentType,
      disposition,
      fileName: file.fileName,
    });

    this.fileMetrics.readSigned({ purpose, actor: grant.actor });
    return { url: signed.url, expiresAt: signed.expiresAt, contentType: file.contentType };
  }

  async getMetadata(
    fileId: string,
    caller: { userId: string; roles: readonly string[] },
  ): Promise<CompleteUploadResult> {
    const file = await this.loadReadable(fileId);
    const grant = decideRead(
      { ownerUserId: file.ownerUserId, purpose: file.purpose as FilePurposeName },
      caller,
    );
    if (!grant.granted) throw new FileNotFoundError();
    return this.toResult(file);
  }

  private async publishReady(
    file: { id: string; purpose: string; contentType: string },
    ownerUserId: string,
    head: { sizeBytes: number; checksumSha256: string | null },
    completedAt: Date,
    requestId: string | null,
  ): Promise<boolean> {
    return this.transactionManager.execute(async (tx) => {
      const won = await this.fileRepository.markReady(
        file.id,
        {
          sizeBytes: head.sizeBytes,
          completedAt,
          ...(head.checksumSha256 != null ? { checksumSha256: head.checksumSha256 } : {}),
        },
        tx,
      );
      if (!won) return false;

      await this.eventPublisher.publish(
        fileEvent('file.uploaded', {
          aggregateId: file.id,
          subjectUserId: ownerUserId,
          requestId,
          data: {
            fileId: file.id,
            ownerUserId,
            purpose: file.purpose,
            contentType: file.contentType,
            sizeBytes: head.sizeBytes,
          },
        }),
        tx,
      );
      return true;
    });
  }

  async remove(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<void> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId);
    if (!file) throw new FileNotFoundError();
    if (file.status === 'DELETED') return;
    if (file.status !== 'READY') throw new FileNotFoundError();

    const purpose = file.purpose as FilePurposeName;
    const holder = await findLiveReference(purpose, file.id);
    if (holder) throw new FileInUseError(holder);

    const deletedAt = new Date();
    await this.transactionManager.execute(async (tx) => {
      const won = await this.fileRepository.softDelete(file.id, deletedAt, tx);
      if (!won) return;

      await this.eventPublisher.publish(
        fileEvent('file.deleted', {
          aggregateId: file.id,
          subjectUserId: file.ownerUserId,
          requestId,
          data: {
            fileId: file.id,
            ownerUserId: file.ownerUserId,
            purpose,
            actor: 'self',
            actorUserId: ownerUserId,
          },
        }),
        tx,
      );
    });
  }

  async releaseInTransaction(
    fileId: string,
    ownerUserId: string,
    tx: TransactionClient,
    requestId: string | null = null,
  ): Promise<boolean> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId, tx);
    if (!file || file.status !== 'READY') return false;

    const won = await this.fileRepository.softDelete(file.id, new Date(), tx);
    if (!won) return false;

    await this.eventPublisher.publish(
      fileEvent('file.deleted', {
        aggregateId: file.id,
        subjectUserId: file.ownerUserId,
        requestId,
        data: {
          fileId: file.id,
          ownerUserId: file.ownerUserId,
          purpose: file.purpose,
          actor: 'self',
          actorUserId: ownerUserId,
        },
      }),
      tx,
    );
    return true;
  }

  async assertReferenceable(
    fileId: string,
    ownerUserId: string,
    purpose: FilePurposeName,
    tx: TransactionClient,
  ): Promise<void> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId, tx);
    if (!file || file.purpose !== purpose) throw new FileNotFoundError();

    if (file.status !== 'READY' || file.deletedAt !== null) {
      throw new FileStateError('That file is not available to attach');
    }

    const holder = await findLiveReference(purpose, fileId, tx);
    if (holder) throw new FileInUseError(holder);
  }

  async supersede(
    previousFileId: string,
    replacementFileId: string,
    tx: TransactionClient,
    requestId: string | null = null,
  ): Promise<void> {
    if (previousFileId === replacementFileId) {
      throw new FileStateError('A file cannot supersede itself');
    }

    const previous = await this.fileRepository.findById(previousFileId, tx);
    const replacement = await this.fileRepository.findById(replacementFileId, tx);
    if (!previous || !replacement) throw new FileNotFoundError();

    if (previous.ownerUserId !== replacement.ownerUserId) {
      throw new FileStateError('A replacement must belong to the same owner');
    }
    if (previous.purpose !== replacement.purpose) {
      throw new FileStateError('A replacement must share the previous purpose');
    }
    if (replacement.status !== 'READY') {
      throw new FileStateError('The replacement file is not available to attach');
    }

    const won = await this.fileRepository.markSuperseded(previousFileId, replacementFileId, tx);
    if (!won) throw new FileStateError('That file is no longer the current version');

    await this.eventPublisher.publish(
      fileEvent('file.superseded', {
        aggregateId: previous.id,
        subjectUserId: previous.ownerUserId,
        requestId,
        data: {
          fileId: previous.id,
          replacementFileId: replacement.id,
          ownerUserId: previous.ownerUserId,
          purpose: previous.purpose,
        },
      }),
      tx,
    );
  }

  private async loadReadable(fileId: string): Promise<{
    id: string;
    ownerUserId: string;
    purpose: string;
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string | null;
    createdAt: Date;
  }> {
    const file = await this.fileRepository.findReadable(fileId);
    if (!file) throw new FileNotFoundError();
    return file;
  }

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
