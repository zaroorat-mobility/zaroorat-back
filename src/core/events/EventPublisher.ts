import { randomUUID } from 'node:crypto';
import { logger } from '@shared/logger/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { OutboxRepository } from './OutboxRepository';
import { EventBus } from './EventBus';
import { OutboxMetrics } from './OutboxMetrics';
import { isDurable, type EventEnvelope, type PublishInput } from './types';
const ENVELOPE_VERSION = 1;
const DEFAULT_EVENT_VERSION = 1;
export class EventPublisher {
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly eventBus: EventBus,
    private readonly outboxMetrics: OutboxMetrics,
  ) {}
  async publish(input: PublishInput, tx?: TransactionClient): Promise<void> {
    if (!isDurable(input.classification)) {
      if (tx) {
        throw new Error(
          `Observability event "${input.type}" was published with a transaction client. ` +
            'Best-effort events emit immediately and cannot participate in a transaction.',
        );
      }
      const envelope = this.buildEnvelope(input);
      void this.eventBus
        .emit(envelope)
        .then(({ failures }) => {
          if (failures.length === 0) return;
          this.outboxMetrics.observabilityDropped({ eventType: input.type });
          logger.warn(
            {
              eventId: envelope.eventId,
              type: input.type,
              failures: failures.map(EventPublisher.describe),
            },
            '[events] observability subscriber(s) failed; not retried',
          );
        })
        .catch((err: unknown) => {
          logger.error({ err, type: input.type }, '[events] observability dispatch failed');
        });
      return;
    }
    const aggregateId = input.aggregateId ?? input.subjectUserId;
    if (!aggregateId) {
      throw new Error(
        `Durable event "${input.type}" requires an aggregateId. ` +
          'An outbox row with no aggregate cannot be ordered or replayed per aggregate.',
      );
    }
    const envelope = this.buildEnvelope(input);
    await this.outboxRepository.enqueue(
      {
        eventId: envelope.eventId,
        aggregateType: input.aggregateType,
        aggregateId,
        eventType: input.type,
        payload: envelope,
      },
      tx,
    );
  }
  private static describe(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }
  private buildEnvelope(input: PublishInput): EventEnvelope {
    return {
      eventId: randomUUID(),
      type: input.type,
      version: input.version ?? DEFAULT_EVENT_VERSION,
      envelopeVersion: ENVELOPE_VERSION,
      occurredAt: new Date().toISOString(),
      producer: input.producer,
      subject: { userId: input.subjectUserId ?? null },
      correlation: { requestId: input.requestId ?? null, sessionId: input.sessionId ?? null },
      data: input.data,
    };
  }
}
