import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventPublisher } from '../../../src/core/events/EventPublisher.js';
import type { EventBus } from '../../../src/core/events/EventBus.js';
import type { OutboxRepository, OutboxRecord } from '../../../src/core/events/OutboxRepository.js';
import type { EventEnvelope, PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

interface EnqueueCall {
  record: OutboxRecord;
  tx: TransactionClient | undefined;
}

function makeHarness() {
  const emitted: EventEnvelope[] = [];
  const enqueued: EnqueueCall[] = [];

  const bus = { emit: (e: EventEnvelope) => emitted.push(e) } as unknown as EventBus;
  const outbox = {
    enqueue: async (record: OutboxRecord, tx?: TransactionClient) => {
      enqueued.push({ record, tx });
    },
  } as unknown as OutboxRepository;

  return { publisher: new EventPublisher(outbox, bus), emitted, enqueued };
}

const observability: PublishInput = {
  type: 'auth.otp.sent',
  classification: 'observability',
  aggregateType: 'phone',
  subjectUserId: null,
  data: { provider: 'mock' },
};

const audit: PublishInput = {
  type: 'auth.login.succeeded',
  classification: 'audit',
  aggregateType: 'user',
  aggregateId: '11111111-1111-1111-1111-111111111111',
  subjectUserId: '11111111-1111-1111-1111-111111111111',
  sessionId: 's-1',
  requestId: 'req-1',
  data: { loginMethod: 'otp' },
};

// Proves the doc 06 routing contract: observability → bus (best-effort), audit →
// outbox (durable, in the caller's tx), plus the canonical envelope shape (§3).
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
});
