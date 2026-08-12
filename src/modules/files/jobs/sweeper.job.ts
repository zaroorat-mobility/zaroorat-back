import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../metrics/file.metrics.js';
import type { StorageProvider } from '../providers/storage.provider.js';

const SWEEP_LOCK = 'file:sweeper';

const SWEEP_LOCK_TTL_MS = 10 * 60 * 1000;

export interface SweepResult {
  ran: boolean;
  scanned: number;
  reclaimed: number;
  failed: number;
}

export class FileSweeperJob {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

  async run(now: Date = new Date()): Promise<SweepResult> {
    const token = await this.redisService.lock.acquire(SWEEP_LOCK, SWEEP_LOCK_TTL_MS);
    if (!token) return { ran: false, scanned: 0, reclaimed: 0, failed: 0 };

    try {
      const stale = await this.fileRepository.findSweepable(now, fileConfig.sweeperBatchSize);
      let reclaimed = 0;
      let failed = 0;

      for (const file of stale) {
        try {
          await this.storageProvider.delete(file.storageKey);
          await this.fileRepository.deleteReservation(file.id);
          reclaimed += 1;
        } catch (err) {
          failed += 1;
          logger.warn({ err, fileId: file.id }, '[Files] sweep failed; retrying next run');
        }
      }

      this.fileMetrics.sweeperReclaimed({ count: reclaimed, failed });
      this.fileMetrics.storageGauge('objects.pending', {
        value: await this.fileRepository.countPending(),
      });

      return { ran: true, scanned: stale.length, reclaimed, failed };
    } finally {
      await this.redisService.lock.release(SWEEP_LOCK, token);
    }
  }
}
