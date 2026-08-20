import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { fileConfig, type FilePurposeName } from '@config/file/file.config.js';
import { RateLimitedError } from '@modules/auth/errors';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../metrics/file.metrics.js';
import { fileEvent } from '../events/catalog.js';
import { FileNotFoundError } from '../errors/file.errors.js';
import { toFileResult } from '../utils/file-result.js';
import { FILE_READ_SCOPE } from '../constants/file.constants.js';
import type { CompleteUploadResult, FileCaller, FileReadUrl } from '../types/file.types.js';
import { FileStorageService } from './file-storage.service.js';
import { FileValidationService } from './file-validation.service.js';
export type ReadGrant =
  | {
      granted: true;
      actor: 'owner';
    }
  | {
      granted: true;
      actor: 'ops';
      scope: string;
    }
  | {
      granted: false;
    };
const OPS_SCOPE_FOR_PURPOSE: Readonly<Record<FilePurposeName, string>> = Object.freeze({
  PROFILE_IMAGE: 'users:read',
  DRIVER_DOCUMENT: 'drivers:verify',
  VEHICLE_DOCUMENT: 'drivers:verify',
  VEHICLE_IMAGE: 'drivers:verify',
  SOS_EVIDENCE: 'safety:read',
  DISPUTE_EVIDENCE: 'support:read',
});
const SCOPES_FOR_ROLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  admin: Object.freeze(['users:read', 'drivers:verify', 'safety:read', 'support:read']),
  support: Object.freeze(['support:read', 'safety:read']),
});
export function decideRead(
  file: {
    ownerUserId: string;
    purpose: FilePurposeName;
  },
  caller: {
    userId: string;
    roles: readonly string[];
  },
): ReadGrant {
  if (file.ownerUserId === caller.userId) return { granted: true, actor: 'owner' };
  const required = OPS_SCOPE_FOR_PURPOSE[file.purpose];
  const held = caller.roles.flatMap((role) => SCOPES_FOR_ROLE[role] ?? []);
  if (held.includes(required)) return { granted: true, actor: 'ops', scope: required };
  return { granted: false };
}
export class FileAccessService {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly fileStorageService: FileStorageService,
    private readonly fileValidationService: FileValidationService,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}
  decideRead(
    file: {
      ownerUserId: string;
      purpose: FilePurposeName;
    },
    caller: {
      userId: string;
      roles: readonly string[];
    },
  ): ReadGrant {
    return decideRead(file, caller);
  }
  async getReadUrl(
    fileId: string,
    caller: FileCaller,
    disposition: 'inline' | 'attachment' = 'inline',
    requestId: string | null = null,
  ): Promise<FileReadUrl> {
    const limit = await this.redisService.rateLimit.hit(
      FILE_READ_SCOPE,
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
    const signed = await this.fileStorageService.signDownload({
      key: file.storageKey,
      ttlSeconds: this.fileValidationService.policyFor(purpose).readTtlSeconds,
      contentType: file.contentType,
      disposition,
      fileName: file.fileName,
    });
    this.fileMetrics.readSigned({ purpose, actor: grant.actor });
    return { url: signed.url, expiresAt: signed.expiresAt, contentType: file.contentType };
  }
  async getMetadata(fileId: string, caller: FileCaller): Promise<CompleteUploadResult> {
    const file = await this.loadReadable(fileId);
    const grant = decideRead(
      { ownerUserId: file.ownerUserId, purpose: file.purpose as FilePurposeName },
      caller,
    );
    if (!grant.granted) throw new FileNotFoundError();
    return toFileResult(file);
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
}
