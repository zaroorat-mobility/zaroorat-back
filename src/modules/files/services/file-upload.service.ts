import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { fileConfig, type FilePurposeName } from '@config/file/file.config.js';
import { RateLimitedError } from '@modules/auth/errors';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../metrics/file.metrics.js';
import { fileEvent } from '../events/catalog.js';
import { buildStorageKey } from '../utils/storage-key.js';
import { sanitizeFileName } from '../utils/filename.js';
import { toFileResult } from '../utils/file-result.js';
import { FILE_UPLOAD_PURPOSE_SCOPE, FILE_UPLOAD_USER_SCOPE } from '../constants/file.constants.js';
import {
  ChecksumMismatchError,
  ContentMismatchError,
  ExifLocationError,
  FileNotFoundError,
  FileStateError,
  FileTooLargeError,
  UploadExpiredError,
  UploadNotFoundError,
} from '../errors/file.errors.js';
import type { RejectionReason } from './file-validation.service.js';
import { logger } from '@shared/logger/index.js';
import type { StorageConfig } from '../config/storage.config.js';
import type {
  AdmittedObject,
  CompleteUploadResult,
  CreateUploadInput,
  CreateUploadResult,
} from '../types/file.types.js';
import { FileStorageService } from './file-storage.service.js';
import { FileValidationService } from './file-validation.service.js';
const ERROR_FOR_REJECTION: Record<RejectionReason, () => Error> = {
  SIZE_LIMIT_EXCEEDED: () => new FileTooLargeError('sizeBytes', 0),
  DIMENSIONS_EXCEEDED: () => new FileTooLargeError('dimensions', 0),
  CONTENT_MISMATCH: () => new ContentMismatchError(),
  CHECKSUM_MISMATCH: () => new ChecksumMismatchError(),
  EXIF_LOCATION_PRESENT: () => new ExifLocationError(),
};
export class FileUploadService {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly fileStorageService: FileStorageService,
    private readonly fileValidationService: FileValidationService,
    private readonly storageConfig: StorageConfig,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}
  async createUpload(input: CreateUploadInput): Promise<CreateUploadResult> {
    this.fileValidationService.assertDeclaredUploadAllowed(
      input.purpose,
      input.contentType,
      input.sizeBytes,
    );
    await this.assertWithinLimits(input.ownerUserId, input.purpose, input.sizeBytes);
    const storageKey = buildStorageKey(input.purpose, input.contentType);
    const uploadExpiresAt = new Date(Date.now() + this.storageConfig.uploadUrlTtlSeconds * 1000);
    const file = await this.fileRepository.create({
      ownerUserId: input.ownerUserId,
      purpose: input.purpose,
      storageKey,
      storageProvider: this.fileStorageService.providerName,
      storageBucket: this.fileStorageService.quarantineBucket,
      fileName: sanitizeFileName(input.fileName, input.contentType),
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadExpiresAt,
      ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
    });
    const signed = await this.fileStorageService.signUpload({
      key: storageKey,
      contentType: input.contentType,
      contentLength: input.sizeBytes,
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
    if (file.status === 'READY') return toFileResult(file);
    if (file.status !== 'PENDING') {
      throw new FileStateError('That file is not awaiting completion');
    }
    if (file.uploadExpiresAt.getTime() <= Date.now()) {
      await this.expireUpload(file.id, file.storageKey, file.purpose as FilePurposeName);
      throw new UploadExpiredError();
    }
    const purpose = file.purpose as FilePurposeName;
    const admitted = await this.admitStoredObject(file, purpose);
    if (!admitted) throw new UploadNotFoundError();
    const completedAt = new Date();
    const transitioned = await this.publishReady(
      file,
      ownerUserId,
      admitted,
      completedAt,
      requestId,
    );
    if (!transitioned) {
      const settled = await this.fileRepository.findOwned(fileId, ownerUserId);
      if (!settled) throw new FileNotFoundError();
      return toFileResult(settled);
    }
    this.fileMetrics.uploadCompleted({ purpose, sizeBytes: admitted.sizeBytes });
    this.fileMetrics.uploadDuration({
      purpose,
      ms: completedAt.getTime() - file.createdAt.getTime(),
    });
    return toFileResult({
      id: file.id,
      purpose: file.purpose,
      contentType: file.contentType,
      createdAt: file.createdAt,
      sizeBytes: admitted.sizeBytes,
      checksumSha256: admitted.checksumSha256,
    });
  }
  async admitStoredObject(
    file: {
      id: string;
      storageKey: string;
      contentType: string;
      checksumSha256: string | null;
    },
    purpose: FilePurposeName,
  ): Promise<AdmittedObject | null> {
    const peekBytes = this.fileValidationService.peekBudgetFor(
      file.contentType,
      this.storageConfig.peekBytes,
      this.storageConfig.imagePeekBytes,
    );
    const head = await this.fileStorageService.headQuarantined(file.storageKey, peekBytes);
    if (!head) {
      this.fileMetrics.uploadRejected({ purpose, reason: 'UPLOAD_NOT_FOUND' });
      return null;
    }
    const observedAt = new Date();
    const verdict = this.fileValidationService.validateStoredObject(
      purpose,
      { contentType: file.contentType, checksumSha256: file.checksumSha256 },
      head,
    );
    if (!verdict.ok) {
      await this.rejectUpload(file.id, file.storageKey, purpose, verdict.reason);
      throw ERROR_FOR_REJECTION[verdict.reason]();
    }
    await this.fileStorageService.promote(file.storageKey);
    return {
      sizeBytes: verdict.sizeBytes,
      checksumSha256: verdict.checksumSha256,
      detectedContentType: verdict.detectedContentType,
      versionId: verdict.versionId,
      uploadedAt: observedAt,
      verifiedAt: observedAt,
    };
  }
  async publishReady(
    file: {
      id: string;
      purpose: string;
      contentType: string;
    },
    ownerUserId: string,
    admitted: AdmittedObject,
    completedAt: Date,
    requestId: string | null,
  ): Promise<boolean> {
    return this.transactionManager.execute(async (tx) => {
      const won = await this.fileRepository.markReady(
        file.id,
        {
          sizeBytes: admitted.sizeBytes,
          checksumSha256: admitted.checksumSha256,
          detectedContentType: admitted.detectedContentType,
          uploadedAt: admitted.uploadedAt,
          verifiedAt: admitted.verifiedAt,
          completedAt,
          storageBucket: this.fileStorageService.trustedBucket,
          storageVersionId: admitted.versionId,
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
            sizeBytes: admitted.sizeBytes,
          },
        }),
        tx,
      );
      return true;
    });
  }
  private async expireUpload(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
  ): Promise<void> {
    this.fileMetrics.uploadExpired({ purpose });
    try {
      await this.fileStorageService.discardQuarantined(storageKey);
    } catch (err) {
      logger.warn({ err, fileId }, '[Files] failed to remove an expired object');
    }
    await this.fileRepository.markExpired(fileId);
  }
  private async rejectUpload(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
    reason: string,
  ): Promise<void> {
    this.fileMetrics.uploadRejected({ purpose, reason });
    try {
      await this.fileStorageService.discardQuarantined(storageKey);
    } catch (err) {
      logger.warn({ err, fileId }, '[Files] failed to remove a refused object');
    }
    await this.fileRepository.markRejected(fileId, reason, new Date());
  }
  private async assertWithinLimits(
    ownerUserId: string,
    purpose: FilePurposeName,
    sizeBytes: number,
  ): Promise<void> {
    const perUser = await this.redisService.rateLimit.hit(
      FILE_UPLOAD_USER_SCOPE,
      ownerUserId,
      fileConfig.uploadsPerUserPerHour,
      3600,
    );
    if (!perUser.allowed) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'user' });
      throw new RateLimitedError(perUser.retryAfterSeconds);
    }
    const perPurpose = await this.redisService.rateLimit.hit(
      FILE_UPLOAD_PURPOSE_SCOPE,
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
}
