import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig, filePurposePolicy, type FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { FileMetrics } from '../file.metrics.js';
import { fileEvent } from '../events/catalog.js';
import { findLiveReference, hasFileReferenceOwner } from '../file-references.js';
import type { StorageProvider } from '../providers/storage.provider.js';

/** Redis hash holding files retention gave up on (doc 09 §4.3). */
const DEAD_LETTER_KEY = 'file:retention:deadletter';

/** Redis key prefix for per-file attempt counters. */
const ATTEMPTS_PREFIX = 'file:retention:attempts:';

/** How long an attempt counter survives — longer than any plausible outage. */
const ATTEMPTS_TTL_SECONDS = 30 * 24 * 3600;

/** Milliseconds in a day, for turning a retention window into a cutoff. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** What one retention run did (doc 06 §8). */
export interface RetentionResult {
  scanned: number;
  archived: number;
  erased: number;
  /** A module still holds a reference (R-FILE-19). */
  blocked: number;
  /** No module owns that purpose's references, so nothing could be asked. */
  unclaimed: number;
  failed: number;
}

/** One entry in the dead-letter queue. */
export interface DeadLetteredFile {
  fileId: string;
  purpose: string;
  attempts: number;
  error: string;
  at: string;
}

/**
 * Executes the retention policy (R-FILE-18/19/20/21/23, doc 09 §4.2).
 *
 * The job that makes a compliance promise true. It is also the only code in this
 * module that destroys anything, which is why almost all of it is refusals.
 *
 * **Inert until a job runtime exists** (doc 01 §13.4) — written as a plain
 * service and tested by direct invocation (doc 06 §8).
 */
export class FileRetentionJob {
  /**
   * @param fileRepository Data access for `files`.
   * @param storageProvider The configured storage backend.
   * @param transactionManager Unit of work for the terminal-outcome write.
   * @param eventPublisher Outbox writer for `file.erased`.
   * @param redisService Attempt counters and the dead-letter queue.
   * @param fileMetrics Counters and the doc 09 §2.4 gauges.
   */
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

  /**
   * Process one batch of files whose retention window has closed.
   *
   * Per-file and isolated: one file's failure never aborts the batch, because a
   * single unreachable object must not stop the other hundred and ninety-nine
   * from meeting their window.
   *
   * @param now The run instant; injectable so a test need not wait eight years.
   * @returns A breakdown of the run, including every reason a file was skipped.
   */
  async run(now: Date = new Date()): Promise<RetentionResult> {
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

      // R-FILE-19 says retention asks the owning module before erasing. A
      // purpose no module has claimed cannot be asked — and "nobody answered"
      // must never be read as consent to destroy bytes. Until `documents` and
      // the rest exist, this is what keeps doc 03 §6's "the only erasable
      // purpose is PROFILE_IMAGE" true by construction rather than by luck.
      if (!hasFileReferenceOwner(purpose)) {
        result.unclaimed += 1;
        continue;
      }

      const holder = await findLiveReference(purpose, file.id);
      if (holder) {
        // FILE-INV-5. Sustained, this is the doc 09 §2.5 alert: a consumer that
        // never releases a reference means a compliance window closes with the
        // bytes still in place.
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

  /**
   * Files retention has given up on, for the runbook entry in doc 09 §5.
   * @returns Every dead-lettered file with its last error.
   */
  async deadLettered(): Promise<DeadLetteredFile[]> {
    const entries = await this.redisService.provider.client.hgetall(DEAD_LETTER_KEY);
    return Object.values(entries).map((value) => JSON.parse(value) as DeadLetteredFile);
  }

  /**
   * Carry out one file's terminal outcome.
   *
   * The storage call happens **outside** the transaction (R-FILE-25) — a remote
   * call inside one holds a database connection across the network's worst case.
   * The ordering that leaves is deliberate: if the row write then fails, the
   * bytes are already gone and the next run repeats an idempotent operation
   * before recording it. The reverse would record an erasure that never
   * happened, which is the one outcome an audit trail must never contain.
   *
   * `archive()` or `erase()`, **never `delete()`**: on the versioned bucket this
   * platform mandates, a plain delete writes a marker and leaves every version
   * retrievable while `file.erased` announces they are gone (doc 08 §2.2).
   */
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
          // No subject and no owner id, deliberately (doc 05 §3.5): by the time
          // this fires the point is that the subject's data is gone, and
          // restating whose it was in a durable event undercuts the erasure.
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

  /**
   * Count a failure and dead-letter the file once it has run out of attempts.
   *
   * Retention gets a dead-letter queue and the sweeper does not because the
   * failure modes are not comparable: an unswept orphan costs a row, while a
   * file that should have been erased and was not is a compliance finding. It
   * must not fail silently, and it must not retry forever pretending it will
   * eventually work — after `jobMaxAttempts`, a human decides (doc 09 §4.3).
   */
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
      // The message only. A provider's own prose leaks topology (doc 04 §5), and
      // this string reaches an operator's console.
      error: err instanceof Error ? err.message : 'unknown error',
      at: new Date().toISOString(),
    };
    await client.hset(DEAD_LETTER_KEY, fileId, JSON.stringify(entry));
    this.fileMetrics.retentionBlocked({ purpose, reason: 'DEAD_LETTERED' });
  }

  /**
   * One cutoff per purpose: a file closed at or before it is due.
   *
   * The window is the **purpose's full window measured from the close**
   * (R-FILE-32) — a superseded licence was valid evidence for the period it was
   * current, so it is kept because it *was* valid, not discarded because it no
   * longer is.
   */
  private cutoffs(now: Date): { purpose: FilePurposeName; closedBefore: Date }[] {
    return (Object.keys(filePurposePolicy) as FilePurposeName[]).map((purpose) => ({
      purpose,
      closedBefore: new Date(
        now.getTime() - filePurposePolicy[purpose].retention.afterDays * DAY_MS,
      ),
    }));
  }

  /** Emit the doc 09 §2.4 gauges from rows this run already had to read. */
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
