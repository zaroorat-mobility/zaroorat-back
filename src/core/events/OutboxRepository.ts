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
export interface PublishedOutboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  publishedAt: Date;
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
    // The ORDER BY inside the subquery decides WHICH rows are claimed (the
    // oldest ones), but RETURNING carries no ordering guarantee of its own —
    // postgres emits updated rows in whatever order it touched them. Wrapping
    // the UPDATE in a CTE and ordering the outer SELECT is what actually makes
    // the batch oldest-first, which is the order the relay publishes in.
    return this.client.$queryRaw<ClaimedOutboxEvent[]>`
      WITH claimed AS (
        UPDATE outbox_events
        SET status = 'PROCESSING', claimed_at = ${now}, claim_token = ${claimToken}::uuid
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status = 'PENDING' AND next_attempt_at <= ${now}
          ORDER BY created_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, event_type, retries, payload, claim_token, created_at
      )
      SELECT id, event_type AS "eventType", retries, payload, claim_token AS "claimToken"
      FROM claimed
      ORDER BY created_at, id
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
  /// PUBLISHED events of the given types, published in [after, before), oldest
  /// first, continuing strictly after `after` (keyset on `(publishedAt, id)`, so
  /// a batch sharing one `publishedAt` is paged without skipping or repeating).
  /// Read-only; served by `outbox_events_status_published_at_idx`.
  async findPublishedPage(input: {
    after: { publishedAt: Date; id: string };
    before: Date;
    eventTypes: readonly string[];
    limit: number;
  }): Promise<PublishedOutboxEvent[]> {
    const rows = await this.client.outboxEvent.findMany({
      where: {
        status: 'PUBLISHED',
        eventType: { in: [...input.eventTypes] },
        publishedAt: { gte: input.after.publishedAt, lt: input.before },
        OR: [{ publishedAt: { gt: input.after.publishedAt } }, { id: { gt: input.after.id } }],
      },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: {
        id: true,
        eventId: true,
        eventType: true,
        payload: true,
        createdAt: true,
        publishedAt: true,
      },
    });
    // The `publishedAt` range excludes NULL, so every row has one.
    return rows.map((row) => ({ ...row, publishedAt: row.publishedAt! }));
  }
  /// How many PUBLISHED events of the given types were published in
  /// [from, before) — `before` omitted means no upper bound. Read-only, for
  /// observability; served by the same index as `findPublishedPage`.
  async countPublished(input: {
    from: Date;
    before?: Date;
    eventTypes: readonly string[];
  }): Promise<number> {
    return this.client.outboxEvent.count({
      where: {
        status: 'PUBLISHED',
        eventType: { in: [...input.eventTypes] },
        publishedAt: { gte: input.from, ...(input.before ? { lt: input.before } : {}) },
      },
    });
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
