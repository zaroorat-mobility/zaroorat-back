import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig, filePurposePolicy, type FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../metrics/file.metrics.js';
import { fileEvent } from '../events/catalog.js';
import { findLiveReference, hasFileReferenceOwner } from '../references/file-references.js';
import type { StorageProvider } from '../providers/storage.provider.js';

const DEAD_LETTER_KEY = 'file:retention:deadletter';

const RETENTION_LOCK = 'file:retention';

const RETENTION_LOCK_TTL_MS = 15 * 60 * 1000;

const ATTEMPTS_PREFIX = 'file:retention:attempts:';

const ATTEMPTS_TTL_SECONDS = 30 * 24 * 3600;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  scanned: number;
  archived: number;
  erased: number;
  blocked: number;
  unclaimed: number;
  failed: number;
}

export interface DeadLetteredFile {
  fileId: string;
  purpose: string;
  attempts: number;
  error: string;
  at: string;
}

export class FileRetentionJob {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

  async run(now: Date = new Date()): Promise<RetentionResult> {
    const token = await this.redisService.lock.acquire(RETENTION_LOCK, RETENTION_LOCK_TTL_MS);
    if (!token) {
      return { scanned: 0, archived: 0, erased: 0, blocked: 0, unclaimed: 0, failed: 0 };
    }

    try {
      return await this.sweep(now);
    } finally {
      await this.redisService.lock.release(RETENTION_LOCK, token);
    }
  }

  private async sweep(now: Date): Promise<RetentionResult> {
    const candidates = await this.fileRepository.findRetainable(
      this.cutoffs(now),
      fileConfig.retentionBatchSize,
    );

    const result: RetentionResult = {
      scanned: candidates.length,
      archived: 0,
      erased: 0,
      blocked: 0,
      unclaimed: 0,
      failed: 0,
    };

    for (const file of candidates) {
      const purpose = file.purpose as FilePurposeName;

      if (!hasFileReferenceOwner(purpose)) {
        result.unclaimed += 1;
        continue;
      }

      const holder = await findLiveReference(purpose, file.id);
      if (holder) {
        result.blocked += 1;
        this.fileMetrics.retentionBlocked({ purpose, reason: 'REFERENCED' });
        continue;
      }

      const outcome =
        filePurposePolicy[purpose].retention.action === 'ARCHIVE' ? 'ARCHIVED' : 'ERASED';
      try {
        await this.retire(file.id, file.storageKey, purpose, outcome);
        if (outcome === 'ARCHIVED') {
          result.archived += 1;
          this.fileMetrics.retentionArchived({ purpose });
        } else {
          result.erased += 1;
          this.fileMetrics.retentionErased({ purpose });
        }
      } catch (err) {
        result.failed += 1;
        await this.recordFailure(file.id, purpose, err);
      }
    }

    await this.emitGauges();
    return result;
  }

  async deadLettered(): Promise<DeadLetteredFile[]> {
    const entries = await this.redisService.provider.client.hgetall(DEAD_LETTER_KEY);
    return Object.values(entries).map((value) => JSON.parse(value) as DeadLetteredFile);
  }

  private async retire(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
    outcome: 'ARCHIVED' | 'ERASED',
  ): Promise<void> {
    if (outcome === 'ARCHIVED') {
      await this.storageProvider.archive(storageKey);
    } else {
      await this.storageProvider.erase(storageKey);
    }

    const policy = filePurposePolicy[purpose].retention;
    await this.transactionManager.execute(async (tx) => {
      const recorded = await this.fileRepository.markRetired(fileId, outcome, new Date(), tx);
      if (!recorded) return;

      await this.eventPublisher.publish(
        fileEvent('file.erased', {
          aggregateId: fileId,
          subjectUserId: null,
          data: {
            fileId,
            purpose,
            action: outcome,
            retentionRule: policy.trigger,
          },
        }),
        tx,
      );
    });

    await this.redisService.provider.client.del(`${ATTEMPTS_PREFIX}${fileId}`);
  }

  private async recordFailure(
    fileId: string,
    purpose: FilePurposeName,
    err: unknown,
  ): Promise<void> {
    const client = this.redisService.provider.client;
    const key = `${ATTEMPTS_PREFIX}${fileId}`;
    const attempts = await client.incr(key);
    await client.expire(key, ATTEMPTS_TTL_SECONDS);

    logger.warn({ err, fileId, attempts }, '[Files] retention failed');
    if (attempts < fileConfig.jobMaxAttempts) return;

    const entry: DeadLetteredFile = {
      fileId,
      purpose,
      attempts,
      error: err instanceof Error ? err.message : 'unknown error',
      at: new Date().toISOString(),
    };
    await client.hset(DEAD_LETTER_KEY, fileId, JSON.stringify(entry));
    this.fileMetrics.retentionBlocked({ purpose, reason: 'DEAD_LETTERED' });
  }

  private cutoffs(now: Date): { purpose: FilePurposeName; closedBefore: Date }[] {
    return (Object.keys(filePurposePolicy) as FilePurposeName[]).map((purpose) => ({
      purpose,
      closedBefore: new Date(
        now.getTime() - filePurposePolicy[purpose].retention.afterDays * DAY_MS,
      ),
    }));
  }

  private async emitGauges(): Promise<void> {
    this.fileMetrics.storageGauge('objects.deleted_pending_erasure', {
      value: await this.fileRepository.countAwaitingRetention(),
    });
    for (const row of await this.fileRepository.storageByPurpose()) {
      this.fileMetrics.storageGauge('objects.ready', { purpose: row.purpose, value: row.files });
      this.fileMetrics.storageGauge('storage.bytes_total', {
        purpose: row.purpose,
        value: row.bytes,
      });
    }
  }
}
