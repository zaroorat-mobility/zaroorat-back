import { logger } from '@shared/logger/index.js';
import { OutboxRepository } from './OutboxRepository';
import { EventBus } from './EventBus';

/** Default number of events processed per relay tick. */
const DEFAULT_BATCH_SIZE = 100;
/** Default poll interval in milliseconds. */
const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Relays durable events from the outbox to the bus (auth doc 06 §2).
 *
 * Polls pending rows oldest-first, dispatches each to the {@link EventBus}, and
 * marks it published (or failed, incrementing retries). Delivery is at-least-once
 * — consumers must dedupe on `eventId`. A single instance preserves per-subject
 * order; multi-instance deployments would add `FOR UPDATE SKIP LOCKED` to the
 * fetch (noted for scale-out).
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;

  /**
   * @param outboxRepository Pending-event source.
   * @param eventBus Delivery target.
   */
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Process one batch of pending events.
   * @param limit Maximum events to process this tick.
   * @returns The number of events processed.
   */
  async processBatch(limit: number = DEFAULT_BATCH_SIZE): Promise<number> {
    const pending = await this.outboxRepository.fetchPending(limit);
    for (const event of pending) {
      try {
        this.eventBus.emit(event.payload);
        await this.outboxRepository.markPublished(event.id);
      } catch (err) {
        logger.error({ err, eventId: event.id, type: event.eventType }, '[outbox] dispatch failed');
        await this.outboxRepository.markFailed(event.id);
      }
    }
    return pending.length;
  }

  /**
   * Start the polling loop (idempotent).
   * @param intervalMs Poll interval in milliseconds.
   */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processBatch().catch((err) => logger.error({ err }, '[outbox] relay tick failed'));
    }, intervalMs);
    this.timer.unref();
  }

  /** Stop the polling loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
