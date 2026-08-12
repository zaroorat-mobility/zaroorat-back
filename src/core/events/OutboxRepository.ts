import { randomUUID } from 'node:crypto';

import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { EventEnvelope } from './types';

export interface OutboxRecord {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope;
}

export interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  retries: number;
  payload: EventEnvelope;
  claimToken: string;
}

export interface OutboxStats {
  pending: number;
  dead: number;
  oldestPendingAgeMs: number;
}

export class OutboxRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  async enqueue(record: OutboxRecord, tx?: TransactionClient): Promise<void> {
    const db = tx ?? this.client;
    await db.outboxEvent.create({
      data: {
        eventId: record.eventId,
        aggregateType: record.aggregateType,
        aggregateId: record.aggregateId,
        eventType: record.eventType,
        payload: record.payload as unknown as object,
      },
    });
  }

  async claimBatch(limit: number, now: Date = new Date()): Promise<ClaimedOutboxEvent[]> {
    const claimToken = randomUUID();
    return this.client.$queryRaw<ClaimedOutboxEvent[]>`
      UPDATE outbox_events
      SET status = 'PROCESSING', claimed_at = ${now}, claim_token = ${claimToken}::uuid
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING' AND next_attempt_at <= ${now}
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_type AS "eventType", retries, payload, claim_token AS "claimToken"
    `;
  }

  async markPublished(ids: string[], claimToken: string): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.client.outboxEvent.updateMany({
      where: { id: { in: ids }, claimToken },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        claimedAt: null,
        claimToken: null,
        lastError: null,
      },
    });
    return count;
  }

  async releaseUnprocessed(ids: string[], claimToken: string): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.client.outboxEvent.updateMany({
      where: { id: { in: ids }, claimToken },
      data: { status: 'PENDING', claimedAt: null, claimToken: null, nextAttemptAt: new Date() },
    });
    return count;
  }

  async releaseForRetry(
    id: string,
    claimToken: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<number> {
    const { count } = await this.client.outboxEvent.updateMany({
      where: { id, claimToken },
      data: {
        status: 'PENDING',
        retries: { increment: 1 },
        lastError: error,
        nextAttemptAt,
        claimedAt: null,
        claimToken: null,
      },
    });
    return count;
  }

  async markDead(id: string, claimToken: string, error: string): Promise<number> {
    const { count } = await this.client.outboxEvent.updateMany({
      where: { id, claimToken },
      data: {
        status: 'FAILED',
        retries: { increment: 1 },
        lastError: error,
        claimedAt: null,
        claimToken: null,
      },
    });
    return count;
  }

  async reclaimStale(claimedBefore: Date): Promise<number> {
    const { count } = await this.client.outboxEvent.updateMany({
      where: { status: 'PROCESSING', claimedAt: { lt: claimedBefore } },

      data: { status: 'PENDING', claimedAt: null, claimToken: null },
    });
    return count;
  }

  async prunePublished(publishedBefore: Date, limit: number): Promise<number> {
    const deleted = await this.client.$executeRaw`
      DELETE FROM outbox_events
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PUBLISHED' AND published_at < ${publishedBefore}
        LIMIT ${limit}
      )
    `;
    return deleted;
  }

  async stats(now: Date = new Date()): Promise<OutboxStats> {
    const [pending, dead, oldest] = await Promise.all([
      this.client.outboxEvent.count({ where: { status: 'PENDING' } }),
      this.client.outboxEvent.count({ where: { status: 'FAILED' } }),
      this.client.outboxEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true },
      }),
    ]);

    return {
      pending,
      dead,
      oldestPendingAgeMs: oldest ? Math.max(0, now.getTime() - oldest.createdAt.getTime()) : 0,
    };
  }
}
