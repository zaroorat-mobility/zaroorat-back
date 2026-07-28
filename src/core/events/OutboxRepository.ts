import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { EventEnvelope } from './types';

/** A row to append to the outbox. */
export interface OutboxRecord {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope;
}

/** A pending outbox row as read by the relay. */
export interface PendingOutboxEvent {
  id: string;
  eventType: string;
  payload: EventEnvelope;
}

/**
 * Data access for the transactional outbox (`outbox_events`).
 *
 * `enqueue` accepts an optional transaction client so the event row commits in
 * the **same transaction** as the state change it records (auth doc 06 §2). The
 * relay reads pending rows and marks them published/failed.
 */
export class OutboxRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Append an event to the outbox, optionally within a caller's transaction.
   * @param record The aggregate reference, type, and envelope payload.
   * @param tx Transaction client to join (omit for a standalone write).
   */
  async enqueue(record: OutboxRecord, tx?: TransactionClient): Promise<void> {
    const db = tx ?? this.client;
    await db.outboxEvent.create({
      data: {
        aggregateType: record.aggregateType,
        aggregateId: record.aggregateId,
        eventType: record.eventType,
        payload: record.payload as unknown as object,
      },
    });
  }

  /**
   * Fetch the oldest pending events for the relay.
   * @param limit Maximum rows to return.
   * @returns Pending events, oldest first.
   */
  async fetchPending(limit: number): Promise<PendingOutboxEvent[]> {
    const rows = await this.client.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, eventType: true, payload: true },
    });
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      payload: row.payload as unknown as EventEnvelope,
    }));
  }

  /**
   * Mark an event published.
   * @param id Outbox row id.
   */
  async markPublished(id: string): Promise<void> {
    await this.client.outboxEvent.update({
      where: { id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
  }

  /**
   * Mark an event failed and increment its retry count.
   * @param id Outbox row id.
   */
  async markFailed(id: string): Promise<void> {
    await this.client.outboxEvent.update({
      where: { id },
      data: { status: 'FAILED', retries: { increment: 1 } },
    });
  }
}
