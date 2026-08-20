import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import { container } from '../../src/core/di.js';
import { EventBus } from '../../src/core/events/EventBus.js';
import { OutboxMetrics } from '../../src/core/events/OutboxMetrics.js';
import { OutboxRelay } from '../../src/core/events/OutboxRelay.js';
import type { OutboxRepository } from '../../src/core/events/OutboxRepository.js';
import type { EventEnvelope } from '../../src/core/events/types.js';
import { db, resetState } from './helpers/harness.js';

function repo(): OutboxRepository {
  return container.resolve<OutboxRepository>('outboxRepository');
}

const envelope = (eventId: string): EventEnvelope => ({
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

async function seed(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const eventId = randomUUID();
    await repo().enqueue({
      eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'auth.login.succeeded',
      payload: envelope(eventId),
    });
    ids.push(eventId);
  }
  return ids;
}

beforeEach(async () => {
  await resetState();
});

describe('outbox claim protocol', () => {
  it('never hands the same event to two concurrent claimers', async () => {
    await seed(20);

    const batches = await Promise.all([
      repo().claimBatch(20),
      repo().claimBatch(20),
      repo().claimBatch(20),
    ]);

    const claimedIds = batches.flat().map((row) => row.id);
    assert.equal(claimedIds.length, 20, 'every row must be claimed exactly once');
    assert.equal(new Set(claimedIds).size, 20, 'no row may appear in two claims');
  });

  it('leaves nothing claimable once the backlog is taken', async () => {
    await seed(5);
    await repo().claimBatch(5);

    assert.deepEqual(await repo().claimBatch(5), []);
  });

  it('claims oldest-first by (created_at, id)', async () => {
    await seed(5);

    const claimed = await repo().claimBatch(5);
    const ids = claimed.map((row) => row.id);

    assert.deepEqual(
      ids,
      [...ids].sort(),
      'uuid(7) ids are time-ordered, so sorted == oldest-first',
    );
  });

  it('does not claim an event whose backoff has not elapsed', async () => {
    await seed(1);
    const [claimed] = await repo().claimBatch(1);
    await repo().releaseForRetry(
      claimed!.id,
      claimed!.claimToken,
      'boom',
      new Date(Date.now() + 60_000),
    );

    assert.deepEqual(await repo().claimBatch(1), [], 'a backed-off row is not due yet');
  });

  it('returns a released event once its backoff has elapsed, with the attempt counted', async () => {
    await seed(1);
    const [first] = await repo().claimBatch(1);
    await repo().releaseForRetry(first!.id, first!.claimToken, 'boom', new Date(Date.now() - 1));

    const [second] = await repo().claimBatch(1);

    assert.equal(second?.id, first?.id);
    assert.equal(second?.retries, 1, 'the retry counter must survive the round trip');
  });

  it('reclaims a claim abandoned by a dead relay', async () => {
    await seed(3);
    await repo().claimBatch(3);

    assert.deepEqual(await repo().claimBatch(3), []);

    const reclaimed = await repo().reclaimStale(new Date(Date.now() + 1_000));
    assert.equal(reclaimed, 3);
    assert.equal((await repo().claimBatch(3)).length, 3);
  });

  it('does not reclaim a claim that is still fresh', async () => {
    await seed(2);
    await repo().claimBatch(2);

    assert.equal(await repo().reclaimStale(new Date(Date.now() - 60_000)), 0);
  });

  it('refuses a write from a relay whose claim was reaped', async () => {
    await seed(1);
    const [aClaim] = await repo().claimBatch(1);

    await repo().reclaimStale(new Date(Date.now() + 1_000));
    const [bClaim] = await repo().claimBatch(1);
    assert.notEqual(bClaim?.claimToken, aClaim?.claimToken, 'a re-claim mints a new token');

    await repo().releaseForRetry(
      bClaim!.id,
      bClaim!.claimToken,
      'B failed',
      new Date(Date.now() + 60_000),
    );

    const retired = await repo().markPublished([aClaim!.id], aClaim!.claimToken);

    assert.equal(retired, 0, 'A owns nothing, so it retires nothing');
    const row = await db().client.outboxEvent.findFirst();
    assert.equal(row?.status, 'PENDING', 'B’s retry survives');
    assert.equal(row?.retries, 1);
  });

  it('refuses a retry and a dead-letter from a reaped claim too', async () => {
    await seed(1);
    const [aClaim] = await repo().claimBatch(1);
    await repo().reclaimStale(new Date(Date.now() + 1_000));
    const [bClaim] = await repo().claimBatch(1);

    assert.equal(
      await repo().releaseForRetry(aClaim!.id, aClaim!.claimToken, 'stale', new Date()),
      0,
    );
    assert.equal(await repo().markDead(aClaim!.id, aClaim!.claimToken, 'stale'), 0);

    assert.equal(await repo().markPublished([bClaim!.id], bClaim!.claimToken), 1);
  });

  it('releases an undispatched tail immediately, without waiting for the reaper', async () => {
    await seed(3);
    const claimedRows = await repo().claimBatch(3);
    const token = claimedRows[0]!.claimToken;

    const released = await repo().releaseUnprocessed(
      claimedRows.slice(1).map((row) => row.id),
      token,
    );

    assert.equal(released, 2);
    const reclaimable = await repo().claimBatch(3);
    assert.equal(reclaimable.length, 2, 'the tail is claimable right away');
    assert.equal(reclaimable[0]?.retries, 0, 'nothing failed, so nothing is counted against it');
  });

  it('rejects a duplicate envelope id at the database', async () => {
    const eventId = randomUUID();
    const record = {
      eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'auth.login.succeeded',
      payload: envelope(eventId),
    };
    await repo().enqueue(record);

    await assert.rejects(() => repo().enqueue(record));
  });
});

describe('outbox relay against the live table', () => {
  it('retires delivered events and reports an empty backlog', async () => {
    await seed(4);
    const bus = new EventBus();
    const seen: string[] = [];
    bus.onAny((event) => {
      seen.push(event.eventId);
    });

    const result = await new OutboxRelay(repo(), bus, new OutboxMetrics()).processBatch(10);

    assert.equal(result.published, 4);
    assert.equal(seen.length, 4);
    assert.equal((await repo().stats()).pending, 0);
  });

  it('keeps a failed event claimable instead of dropping it', async () => {
    await seed(1);
    const bus = new EventBus();
    bus.onAny(() => {
      throw new Error('consumer down');
    });

    const result = await new OutboxRelay(repo(), bus, new OutboxMetrics()).processBatch(10);
    assert.equal(result.retried, 1);
    assert.equal(result.published, 0);

    const row = await db().client.outboxEvent.findFirst();
    assert.equal(row?.status, 'PENDING', 'a transient failure must stay in the queue');
    assert.equal(row?.retries, 1);
    assert.match(row?.lastError ?? '', /consumer down/);
  });

  it('dead-letters an event that has burned its attempt budget', async () => {
    await seed(1);
    await db().client.outboxEvent.updateMany({ data: { retries: 7 } });

    const bus = new EventBus();
    bus.onAny(() => {
      throw new Error('poison');
    });

    const result = await new OutboxRelay(repo(), bus, new OutboxMetrics()).processBatch(10);

    assert.equal(result.deadLettered, 1);
    const row = await db().client.outboxEvent.findFirst();
    assert.equal(row?.status, 'FAILED');
    assert.equal((await repo().stats()).dead, 1);
  });

  it('reports backlog depth and the age of the oldest pending event', async () => {
    await seed(3);

    const stats = await repo().stats(new Date(Date.now() + 5_000));

    assert.equal(stats.pending, 3);
    assert.equal(stats.dead, 0);
    assert.ok(stats.oldestPendingAgeMs >= 5_000, 'age is measured from the oldest row');
  });

  it('prunes only retired rows past the retention cutoff', async () => {
    await seed(3);
    const bus = new EventBus();
    await new OutboxRelay(repo(), bus, new OutboxMetrics()).processBatch(10);
    await seed(2);

    const pruned = await repo().prunePublished(new Date(Date.now() + 1_000), 100);

    assert.equal(pruned, 3);
    assert.equal(await db().client.outboxEvent.count(), 2);
  });
});
