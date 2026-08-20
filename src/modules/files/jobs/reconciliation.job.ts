import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig, type FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../metrics/file.metrics.js';
import { FileUploadService } from '../services/file-upload.service.js';
import { FileError } from '../errors/file.errors.js';
const RECONCILE_LOCK = 'file:reconciler';
const RECONCILE_LOCK_TTL_MS = 10 * 60 * 1000;
const MIN_AGE_MS = 2 * 60 * 1000;
export interface ReconcileResult {
  ran: boolean;
  scanned: number;
  admitted: number;
  rejected: number;
  absent: number;
  failed: number;
}
export class FileReconciliationJob {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly fileUploadService: FileUploadService,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}
  async run(now: Date = new Date()): Promise<ReconcileResult> {
    const empty: ReconcileResult = {
      ran: false,
      scanned: 0,
      admitted: 0,
      rejected: 0,
      absent: 0,
      failed: 0,
    };
    const token = await this.redisService.lock.acquire(RECONCILE_LOCK, RECONCILE_LOCK_TTL_MS);
    if (!token) return empty;
    const result: ReconcileResult = { ...empty, ran: true };
    try {
      const stale = await this.fileRepository.findReconcilable(
        new Date(now.getTime() - MIN_AGE_MS),
        fileConfig.sweeperBatchSize,
      );
      result.scanned = stale.length;
      for (const file of stale) {
        try {
          const outcome = await this.settle(file);
          result[outcome] += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn({ err, fileId: file.id }, '[Files] reconciliation failed; retrying next run');
        }
      }
    } finally {
      await this.redisService.lock.release(RECONCILE_LOCK, token);
    }
    if (result.admitted > 0 || result.rejected > 0) {
      logger.info({ ...result }, '[Files] reconciliation settled unfinished uploads');
    }
    return result;
  }
  private async settle(file: {
    id: string;
    ownerUserId: string;
    purpose: string;
    storageKey: string;
    contentType: string;
    checksumSha256: string | null;
  }): Promise<'admitted' | 'rejected' | 'absent'> {
    const purpose = file.purpose as FilePurposeName;
    let admitted;
    try {
      admitted = await this.fileUploadService.admitStoredObject(file, purpose);
    } catch (err) {
      if (err instanceof FileError) {
        this.fileMetrics.reconciled({ purpose, outcome: 'rejected' });
        return 'rejected';
      }
      throw err;
    }
    if (!admitted) return 'absent';
    const settled = await this.fileUploadService.publishReady(
      { id: file.id, purpose: file.purpose, contentType: file.contentType },
      file.ownerUserId,
      admitted,
      new Date(),
      null,
    );
    if (!settled) return 'absent';
    this.fileMetrics.reconciled({ purpose, outcome: 'admitted' });
    return 'admitted';
  }
}
