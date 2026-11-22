import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import { container } from '../../src/core/di.js';
import type { OutboxRepository } from '../../src/core/events/OutboxRepository.js';
import type { EventEnvelope } from '../../src/core/events/types.js';
import { db, resetState } from './helpers/harness.js';

function repo(): OutboxRepository {
  return container.resolve<OutboxRepository>('outboxRepository');
}

const buildEnvelope = (eventId: string): EventEnvelope => ({
  eventId,
  type: 'auth.login.succeeded',
  version: 1,
  envelopeVersion: 1,
  occurredAt: new Date().toISOString(),
  producer: 'auth',
  subject: { userId: null },
  correlation: { requestId: null, sessionId: null },
  data: {},
});

async function createOutboxRecord(overrides: {
  status: 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';
  publishedAt?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const eventId = randomUUID();
  const createdAt = overrides.createdAt ?? new Date();

  await db().client.outboxEvent.create({
    data: {
      id,
      eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'auth.login.succeeded',
      payload: buildEnvelope(eventId) as unknown as object,
      status: overrides.status,
      publishedAt: overrides.publishedAt ?? null,
      createdAt,
    },
  });

  return id;
}

beforeEach(async () => {
  await resetState();
});

describe('Outbox Retention & Pruning Safeguards', () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  it('TEST 1: deletes PUBLISHED events older than 30 days', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 60_000));
    const oldPublishedId = await createOutboxRecord({
      status: 'PUBLISHED',
      publishedAt: oldDate,
      createdAt: oldDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, 1000);

    assert.equal(pruned, 1, 'must prune 1 old PUBLISHED event');
    const row = await db().client.outboxEvent.findUnique({ where: { id: oldPublishedId } });
    assert.equal(row, null, 'old PUBLISHED event must be deleted');
  });

  it('TEST 2: preserves PUBLISHED events within 30 days', async () => {
    const recentDate = new Date(Date.now() - (THIRTY_DAYS_MS - 60_000));
    const recentPublishedId = await createOutboxRecord({
      status: 'PUBLISHED',
      publishedAt: recentDate,
      createdAt: recentDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, 1000);

    assert.equal(pruned, 0, 'must NOT prune recent PUBLISHED events');
    const row = await db().client.outboxEvent.findUnique({ where: { id: recentPublishedId } });
    assert.notEqual(row, null, 'recent PUBLISHED event must remain intact');
  });

  it('TEST 3: preserves old PENDING events', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 86400_000));
    const oldPendingId = await createOutboxRecord({
      status: 'PENDING',
      createdAt: oldDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, 1000);

    assert.equal(pruned, 0, 'must NOT prune PENDING events');
    const row = await db().client.outboxEvent.findUnique({ where: { id: oldPendingId } });
    assert.notEqual(row, null, 'old PENDING event must remain in table');
  });

  it('TEST 4: preserves old PROCESSING events', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 86400_000));
    const oldProcessingId = await createOutboxRecord({
      status: 'PROCESSING',
      createdAt: oldDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, 1000);

    assert.equal(pruned, 0, 'must NOT prune PROCESSING events');
    const row = await db().client.outboxEvent.findUnique({ where: { id: oldProcessingId } });
    assert.notEqual(row, null, 'old PROCESSING event must remain in table');
  });

  it('TEST 5: preserves old FAILED events (dead-letter records)', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 86400_000));
    const oldFailedId = await createOutboxRecord({
      status: 'FAILED',
      createdAt: oldDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, 1000);

    assert.equal(pruned, 0, 'must NEVER prune FAILED events');
    const row = await db().client.outboxEvent.findUnique({ where: { id: oldFailedId } });
    assert.notEqual(row, null, 'old FAILED dead-letter event must remain intact');
  });

  it('TEST 6: enforces bounded pagination (does not exceed PRUNE_LIMIT per call)', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 60_000));
    const totalOld = 105;
    const pruneLimit = 50;

    for (let i = 0; i < totalOld; i += 1) {
      await createOutboxRecord({
        status: 'PUBLISHED',
        publishedAt: oldDate,
        createdAt: oldDate,
      });
    }

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, pruneLimit);

    assert.equal(pruned, pruneLimit, `must prune exactly limit (${pruneLimit}) rows`);
    const remainingCount = await db().client.outboxEvent.count({ where: { status: 'PUBLISHED' } });
    assert.equal(remainingCount, totalOld - pruneLimit, 'remaining rows must match total - limit');
  });

  it('TEST 7: repeated maintenance drains old PUBLISHED rows gradually without deleting protected states', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 60_000));
    const recentDate = new Date();

    // Create 15 old published
    for (let i = 0; i < 15; i += 1) {
      await createOutboxRecord({ status: 'PUBLISHED', publishedAt: oldDate, createdAt: oldDate });
    }
    // Create protected rows
    const pendingId = await createOutboxRecord({ status: 'PENDING', createdAt: oldDate });
    const failedId = await createOutboxRecord({ status: 'FAILED', createdAt: oldDate });
    const recentPublishedId = await createOutboxRecord({
      status: 'PUBLISHED',
      publishedAt: recentDate,
      createdAt: recentDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);

    // Pass 1: limit 10
    const pass1 = await repo().prunePublished(cutoff, 10);
    assert.equal(pass1, 10, 'pass 1 prunes 10 rows');

    // Pass 2: limit 10 (removes remaining 5 old published)
    const pass2 = await repo().prunePublished(cutoff, 10);
    assert.equal(pass2, 5, 'pass 2 prunes remaining 5 old rows');

    // Pass 3: limit 10 (0 rows remaining)
    const pass3 = await repo().prunePublished(cutoff, 10);
    assert.equal(pass3, 0, 'pass 3 prunes 0 rows');

    // Verify protected states were unaffected
    assert.notEqual(await db().client.outboxEvent.findUnique({ where: { id: pendingId } }), null);
    assert.notEqual(await db().client.outboxEvent.findUnique({ where: { id: failedId } }), null);
    assert.notEqual(
      await db().client.outboxEvent.findUnique({ where: { id: recentPublishedId } }),
      null,
    );
  });

  it('TEST 8: verifies outbox_events_status_published_at_idx index exists in PostgreSQL catalog', async () => {
    const indexes = await db().client.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'outbox_events' AND indexname = 'outbox_events_status_published_at_idx'
    `;

    assert.equal(indexes.length, 1, 'outbox_events_status_published_at_idx index must exist');
    assert.equal(indexes[0]!.indexname, 'outbox_events_status_published_at_idx');
  });

  it('TEST 9 (Edge Case): published_at IS NULL rows are never deleted', async () => {
    const oldDate = new Date(Date.now() - (THIRTY_DAYS_MS + 86400_000));
    const nullPublishedId = await createOutboxRecord({
      status: 'PUBLISHED',
      publishedAt: null,
      createdAt: oldDate,
    });

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const pruned = await repo().prunePublished(cutoff, 1000);

    assert.equal(pruned, 0, 'rows with published_at = NULL must NOT be pruned');
    const row = await db().client.outboxEvent.findUnique({ where: { id: nullPublishedId } });
    assert.notEqual(row, null, 'row with published_at NULL must remain intact');
  });
});
