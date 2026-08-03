import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../file.metrics.js';
import type { StorageProvider } from '../providers/storage.provider.js';

/** Redis resource name for the single-runner guard. */
const SWEEP_LOCK = 'file:sweeper';

/**
 * Lock lifetime. Long enough for a full batch of remote deletes, short enough
 * that a crashed run frees the lock before the next scheduled tick.
 */
const SWEEP_LOCK_TTL_MS = 10 * 60 * 1000;

/** What one sweep did, for a caller and for the tests (doc 06 §8). */
export interface SweepResult {
  /** False when another runner held the lock. */
  ran: boolean;
  scanned: number;
  reclaimed: number;
  failed: number;
}

/**
 * Reclaims upload permissions that were never completed (R-FILE-22, doc 09 §4.1).
 *
 * Every `POST /files` that is never completed leaves a `PENDING` row and
 * sometimes a partial object: the app was killed mid-upload, the network died,
 * the user changed their mind. Orphans are **harmless while they accumulate** —
 * a `PENDING` row cannot be read and cannot be attached (R-FILE-6) — which is
 * what makes it acceptable that this has nowhere to run yet (doc 01 §13.4).
 *
 * **Inert until a job runtime exists.** There is no scheduler in this codebase,
 * so nothing calls `run()`; it is written as a plain service and tested by direct
 * invocation, the same shape `AccountService.restore()` has in USER (doc 06 §8).
 */
export class FileSweeperJob {
  /**
   * @param fileRepository Data access for `files`.
   * @param storageProvider The configured storage backend.
   * @param redisService Distributed lock, so two runners do not duplicate work.
   * @param fileMetrics Counters and the pending-objects gauge.
   */
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

  /**
   * Reclaim one batch of expired reservations.
   *
   * **Object first, row second.** The ordering is the whole design: a deleted
   * row with a live object is an orphan nobody can ever find, name, or bill for,
   * while a deleted object with a live row is simply retried next pass. One
   * failure mode is permanent and invisible; the other is self-healing.
   *
   * A per-file failure leaves the row alone and the next run picks it up again.
   * There is no dead-letter queue here — unlike retention (doc 09 §4.3) — because
   * the failure mode is "an orphan survives another fifteen minutes", which
   * corrects itself and costs a row.
   *
   * @param now The sweep instant; injectable so a test need not wait out a TTL.
   * @returns What the run did, including `ran: false` when another holder had
   *          the lock.
   */
  async run(now: Date = new Date()): Promise<SweepResult> {
    const token = await this.redisService.lock.acquire(SWEEP_LOCK, SWEEP_LOCK_TTL_MS);
    // Two sweepers deleting the same keys is harmless — every operation here is
    // idempotent — but it is wasted remote calls, and it makes the metrics lie.
    if (!token) return { ran: false, scanned: 0, reclaimed: 0, failed: 0 };

    try {
      const stale = await this.fileRepository.findSweepable(now, fileConfig.sweeperBatchSize);
      let reclaimed = 0;
      let failed = 0;

      for (const file of stale) {
        try {
          // Idempotent, and a delete marker on the versioned bucket is the right
          // outcome: these bytes were never verified and never referenced
          // (doc 08 §2.2).
          await this.storageProvider.delete(file.storageKey);
          await this.fileRepository.deleteReservation(file.id);
          reclaimed += 1;
        } catch (err) {
          failed += 1;
          // No key, no URL — FILE-INV-2 applies to the job's logs too.
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
