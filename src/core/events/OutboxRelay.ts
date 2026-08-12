import { logger } from '@shared/logger/index.js';
import { OutboxRepository, type ClaimedOutboxEvent } from './OutboxRepository';
import { EventBus } from './EventBus';
import { OutboxMetrics } from './OutboxMetrics';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 1_000;

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const CLAIM_TIMEOUT_MS = 5 * 60_000;

const MAINTENANCE_EVERY_TICKS = 60;

const RETENTION_MS = 0;
const PRUNE_LIMIT = 1_000;

const STOP_TIMEOUT_MS = 15_000;

export interface RelayTickResult {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  abandoned: number;
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopping = false;
  private ticks = 0;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly eventBus: EventBus,
    private readonly outboxMetrics: OutboxMetrics,
  ) {}

  async processBatch(limit: number = DEFAULT_BATCH_SIZE): Promise<RelayTickResult> {
    const claimed = await this.outboxRepository.claimBatch(limit);
    const result: RelayTickResult = {
      claimed: claimed.length,
      published: 0,
      retried: 0,
      deadLettered: 0,
      abandoned: 0,
    };
    if (claimed.length === 0) return result;

    const claimToken = claimed[0]!.claimToken;
    const publishedIds: string[] = [];

    for (const [index, event] of claimed.entries()) {
      if (this.stopping) {
        const tail = claimed.slice(index).map((row) => row.id);
        result.abandoned = await this.outboxRepository.releaseUnprocessed(tail, claimToken);
        logger.info(
          { released: result.abandoned },
          '[outbox] shutdown: released the undispatched tail of the batch',
        );
        break;
      }

      const failure = await this.dispatch(event);

      if (!failure) {
        publishedIds.push(event.id);
        continue;
      }

      if (event.retries + 1 >= MAX_ATTEMPTS) {
        const owned = await this.outboxRepository.markDead(event.id, claimToken, failure);
        if (!owned) {
          this.warnClaimLost(event.id, event.eventType);
          continue;
        }
        result.deadLettered += 1;
        this.outboxMetrics.deadLettered({ eventType: event.eventType, attempts: MAX_ATTEMPTS });
        logger.error(
          { eventId: event.id, type: event.eventType, error: failure },
          '[outbox] dead-lettered after exhausting attempts',
        );
        continue;
      }

      const owned = await this.outboxRepository.releaseForRetry(
        event.id,
        claimToken,
        failure,
        new Date(Date.now() + backoffMs(event.retries + 1)),
      );
      if (!owned) {
        this.warnClaimLost(event.id, event.eventType);
        continue;
      }
      result.retried += 1;
      this.outboxMetrics.dispatchFailed({ eventType: event.eventType, attempt: event.retries + 1 });
    }

    result.published = await this.outboxRepository.markPublished(publishedIds, claimToken);
    if (result.published < publishedIds.length) {
      this.outboxMetrics.claimsLost({ count: publishedIds.length - result.published });
      logger.warn(
        { lost: publishedIds.length - result.published },
        '[outbox] claim expired mid-batch; another relay owns those events',
      );
    }

    this.outboxMetrics.batchProcessed(result as unknown as Record<string, number>);
    return result;
  }

  private warnClaimLost(eventId: string, eventType: string): void {
    this.outboxMetrics.claimsLost({ count: 1 });
    logger.warn(
      { eventId, type: eventType },
      '[outbox] claim expired mid-dispatch; leaving the outcome to its current owner',
    );
  }

  private async dispatch(event: ClaimedOutboxEvent): Promise<string | null> {
    try {
      const { failures } = await this.eventBus.emit(event.payload);
      if (failures.length === 0) return null;

      logger.error(
        { eventId: event.id, type: event.eventType, failures: failures.map(describe) },
        '[outbox] subscriber(s) failed',
      );
      return truncate(`${failures.length} subscriber(s) failed: ${describe(failures[0])}`);
    } catch (err) {
      logger.error({ err, eventId: event.id, type: event.eventType }, '[outbox] dispatch failed');
      return truncate(describe(err));
    }
  }

  private async runMaintenance(): Promise<void> {
    const reclaimed = await this.outboxRepository.reclaimStale(
      new Date(Date.now() - CLAIM_TIMEOUT_MS),
    );
    if (reclaimed > 0) {
      this.outboxMetrics.claimsReclaimed({ count: reclaimed });
      logger.warn({ count: reclaimed }, '[outbox] reclaimed claims from a dead relay');
    }

    const stats = await this.outboxRepository.stats();
    this.outboxMetrics.backlog(stats as unknown as Record<string, number>);

    if (RETENTION_MS > 0) {
      const pruned = await this.outboxRepository.prunePublished(
        new Date(Date.now() - RETENTION_MS),
        PRUNE_LIMIT,
      );
      if (pruned > 0) this.outboxMetrics.pruned({ count: pruned });
    }
  }

  private async tick(): Promise<void> {
    this.ticks += 1;
    await this.processBatch();

    if (this.ticks % MAINTENANCE_EVERY_TICKS === 0 && !this.stopping) {
      await this.runMaintenance();
    }
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.stopping = false;

    const schedule = (): void => {
      this.timer = setTimeout(() => {
        this.inFlight = this.tick()
          .catch((err: unknown) => logger.error({ err }, '[outbox] relay tick failed'))
          .finally(() => {
            this.inFlight = null;
            if (this.timer) schedule();
          });
      }, intervalMs);
      this.timer.unref();
    };

    schedule();
  }

  async stop(timeoutMs: number = STOP_TIMEOUT_MS): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.inFlight) return;

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      if ((await Promise.race([this.inFlight, deadline])) === 'timeout') {
        logger.warn(
          { timeoutMs },
          '[outbox] shutdown deadline passed with a batch still in flight; its rows stay claimed until reclaimed',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function backoffMs(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.random() * ceiling;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function truncate(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
