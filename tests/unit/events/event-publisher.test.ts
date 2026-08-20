import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventPublisher } from '../../../src/core/events/EventPublisher.js';
import { OutboxMetrics } from '../../../src/core/events/OutboxMetrics.js';
import type { EventBus } from '../../../src/core/events/EventBus.js';
import type { OutboxRepository, OutboxRecord } from '../../../src/core/events/OutboxRepository.js';
import type { EventEnvelope, PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

interface EnqueueCall {
  record: OutboxRecord;
  tx: TransactionClient | undefined;
}

function makeHarness(emitDelayMs = 0) {
  const emitted: EventEnvelope[] = [];
  const enqueued: EnqueueCall[] = [];

  const bus = {
    emit: async (e: EventEnvelope) => {
      emitted.push(e);
      if (emitDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, emitDelayMs));
      return { delivered: 0, failures: [] };
    },
  } as unknown as EventBus;
  const outbox = {
    enqueue: async (record: OutboxRecord, tx?: TransactionClient) => {
      enqueued.push({ record, tx });
    },
  } as unknown as OutboxRepository;

  return {
    publisher: new EventPublisher(outbox, bus, new OutboxMetrics()),
    emitted,
    enqueued,
  };
}

const observability: PublishInput = {
  type: 'auth.otp.sent',
  classification: 'observability',
  aggregateType: 'phone',
  producer: 'auth',
  subjectUserId: null,
  data: { provider: 'mock' },
};

const audit: PublishInput = {
  type: 'auth.login.succeeded',
  classification: 'audit',
  aggregateType: 'user',
  producer: 'auth',
  aggregateId: '11111111-1111-1111-1111-111111111111',
  subjectUserId: '11111111-1111-1111-1111-111111111111',
  sessionId: 's-1',
  requestId: 'req-1',
  data: { loginMethod: 'otp' },
};

describe('EventPublisher routing', () => {
  it('sends observability events straight to the bus, never the outbox', async () => {
    const { publisher, emitted, enqueued } = makeHarness();
    await publisher.publish(observability);

    assert.equal(emitted.length, 1);
    assert.equal(enqueued.length, 0);
    assert.equal(emitted[0]?.type, 'auth.otp.sent');
  });

  it('writes audit events to the outbox, never the bus', async () => {
    const { publisher, emitted, enqueued } = makeHarness();
    await publisher.publish(audit);

    assert.equal(enqueued.length, 1);
    assert.equal(emitted.length, 0);
    assert.equal(enqueued[0]?.record.eventType, 'auth.login.succeeded');
    assert.equal(enqueued[0]?.record.aggregateType, 'user');
  });

  it('threads the caller transaction through to enqueue (atomic outbox)', async () => {
    const { publisher, enqueued } = makeHarness();
    const tx = { marker: true } as unknown as TransactionClient;
    await publisher.publish(audit, tx);

    assert.equal(enqueued[0]?.tx, tx);
  });

  it('stamps the canonical envelope (producer, version, id, ISO time) on the outbox payload', async () => {
    const { publisher, enqueued } = makeHarness();
    await publisher.publish(audit);
    const payload = enqueued[0]?.record.payload as EventEnvelope;

    assert.equal(payload.producer, 'auth');
    assert.equal(payload.version, 1);
    assert.match(payload.eventId, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(payload.occurredAt)));
    assert.equal(payload.subject.userId, audit.subjectUserId);
    assert.equal(payload.correlation.requestId, 'req-1');
    assert.equal(payload.correlation.sessionId, 's-1');
    assert.deepEqual(payload.data, { loginMethod: 'otp' });
  });

  it('carries the exact caller payload without injecting extra fields (no-secrets, doc 06 §6)', async () => {
    const { publisher, enqueued } = makeHarness();
    await publisher.publish(audit);
    const payload = enqueued[0]?.record.payload as EventEnvelope;
    assert.deepEqual(Object.keys(payload.data), ['loginMethod']);
  });

  it('lifts the envelope id onto the row so the database can reject a double-enqueue', async () => {
    const { publisher, enqueued } = makeHarness();
    await publisher.publish(audit);
    const record = enqueued[0]?.record;

    assert.equal(record?.eventId, (record?.payload as EventEnvelope).eventId);
  });

  it('stamps the catalog payload version separately from the envelope version', async () => {
    const { publisher, enqueued } = makeHarness();
    await publisher.publish({ ...audit, version: 3 });
    const payload = enqueued[0]?.record.payload as EventEnvelope;

    assert.equal(payload.version, 3);
    assert.equal(payload.envelopeVersion, 1);
  });
});

describe('EventPublisher guards', () => {
  it('refuses a durable event with no aggregate rather than inventing one', async () => {
    const { publisher, enqueued } = makeHarness();

    await assert.rejects(
      () => publisher.publish({ ...audit, aggregateId: null, subjectUserId: null }),
      /requires an aggregateId/,
    );
    assert.equal(enqueued.length, 0);
  });

  it('falls back to the subject user when no explicit aggregate is given', async () => {
    const { publisher, enqueued } = makeHarness();
    await publisher.publish({ ...audit, aggregateId: null });

    assert.equal(enqueued[0]?.record.aggregateId, audit.subjectUserId);
  });

  it('refuses a transaction on an observability event, which emits before it commits', async () => {
    const { publisher, emitted } = makeHarness();
    const tx = { marker: true } as unknown as TransactionClient;

    await assert.rejects(
      () => publisher.publish(observability, tx),
      /cannot participate in a transaction/,
    );
    assert.equal(emitted.length, 0);
  });
});

describe('EventPublisher does not make callers wait on best-effort subscribers', () => {
  it('returns without waiting for the subscriber to finish', async () => {
    const { publisher, emitted } = makeHarness(200);

    const started = Date.now();
    await publisher.publish(observability);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 50, `publish must not block on the subscriber (took ${elapsed}ms)`);
    assert.equal(emitted.length, 1, 'the event is still dispatched');
  });

  it('still waits for the durable write, which is the whole point of the outbox', async () => {
    const { publisher, enqueued } = makeHarness();
    await publisher.publish(audit);

    assert.equal(enqueued.length, 1, 'the outbox row exists by the time publish resolves');
  });
});
