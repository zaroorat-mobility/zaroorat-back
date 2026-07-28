import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '@core/database/TransactionManager';
import { OutboxRepository } from './OutboxRepository';
import { EventBus } from './EventBus';
import type { EventEnvelope, PublishInput } from './types';

/** The producer name stamped on every envelope from this service. */
const PRODUCER = 'auth';
/** Current envelope schema version (auth doc 06 §3/§7). */
const ENVELOPE_VERSION = 1;

/**
 * Publishes domain events (auth doc 06).
 *
 * Builds the canonical envelope and routes by classification: `audit`/`domain`
 * events are written to the **outbox** — pass the state change's transaction
 * client so they commit atomically — while `observability` events are emitted
 * best-effort straight to the in-process bus. Payloads must be non-secret (§6).
 */
export class EventPublisher {
  /**
   * @param outboxRepository Durable event store.
   * @param eventBus In-process delivery for best-effort events.
   */
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Publish an event. Durable events require an `aggregateId` (UUID) and commit
   * to the outbox (in `tx` when provided); observability events go to the bus.
   * @param input The event to publish.
   * @param tx Optional transaction client for durable, atomic enqueue.
   */
  async publish(input: PublishInput, tx?: TransactionClient): Promise<void> {
    const envelope = this.buildEnvelope(input);

    if (input.classification === 'observability') {
      this.eventBus.emit(envelope);
      return;
    }

    // Durable (audit/domain): append to the outbox, ideally in the caller's tx.
    await this.outboxRepository.enqueue(
      {
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId ?? input.subjectUserId ?? envelope.eventId,
        eventType: input.type,
        payload: envelope,
      },
      tx,
    );
  }

  private buildEnvelope(input: PublishInput): EventEnvelope {
    return {
      eventId: randomUUID(),
      type: input.type,
      version: ENVELOPE_VERSION,
      occurredAt: new Date().toISOString(),
      producer: PRODUCER,
      subject: { userId: input.subjectUserId ?? null },
      correlation: { requestId: input.requestId ?? null, sessionId: input.sessionId ?? null },
      data: input.data,
    };
  }
}
