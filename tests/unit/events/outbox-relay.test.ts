import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OutboxRelay } from '../../../src/core/events/OutboxRelay.js';
import type { EventBus } from '../../../src/core/events/EventBus.js';
import type {
  OutboxRepository,
  PendingOutboxEvent,
} from '../../../src/core/events/OutboxRepository.js';
import type { EventEnvelope } from '../../../src/core/events/types.js';

const pending = (id: string): PendingOutboxEvent => ({
  id,
  eventType: 'auth.login.succeeded',
  payload: {
    eventId: `evt-${id}`,
    type: 'auth.login.succeeded',
    version: 1,
    occurredAt: new Date().toISOString(),
    producer: 'auth',
    subject: { userId: 'u1' },
    correlation: { requestId: null, sessionId: null },
    data: {},
  },
});

function makeRepo(rows: PendingOutboxEvent[]) {
  const published: string[] = [];
  const failed: string[] = [];
  const repo = {
    fetchPending: async (limit: number) => rows.slice(0, limit),
    markPublished: async (id: string) => {
      published.push(id);
    },
    markFailed: async (id: string) => {
      failed.push(id);
    },
  } as unknown as OutboxRepository;
  return { repo, published, failed };
}

// Proves the relay's at-least-once dispatch (doc 06 §2): emit → markPublished, and
// on a dispatch failure → markFailed (so the row is retried, never lost silently).
describe('OutboxRelay.processBatch', () => {
  it('dispatches each pending event to the bus and marks it published', async () => {
    const emitted: EventEnvelope[] = [];
    const bus = { emit: (e: EventEnvelope) => emitted.push(e) } as unknown as EventBus;
    const { repo, published, failed } = makeRepo([pending('1'), pending('2')]);

    const count = await new OutboxRelay(repo, bus).processBatch(10);

    assert.equal(count, 2);
    assert.deepEqual(
      emitted.map((e) => e.eventId),
      ['evt-1', 'evt-2'],
    );
    assert.deepEqual(published, ['1', '2']);
    assert.deepEqual(failed, []);
  });

  it('marks an event failed (for retry) when dispatch throws', async () => {
    const bus = {
      emit: () => {
        throw new Error('bus down');
      },
    } as unknown as EventBus;
    const { repo, published, failed } = makeRepo([pending('7')]);

    await new OutboxRelay(repo, bus).processBatch(10);

    assert.deepEqual(published, []);
    assert.deepEqual(failed, ['7']);
  });

  it('returns zero and does nothing when the outbox is empty', async () => {
    const bus = { emit: () => {} } as unknown as EventBus;
    const { repo } = makeRepo([]);
    assert.equal(await new OutboxRelay(repo, bus).processBatch(10), 0);
  });
});

describe('OutboxRelay start/stop', () => {
  it('is idempotent to start and safe to stop without a running timer', () => {
    const bus = { emit: () => {} } as unknown as EventBus;
    const { repo } = makeRepo([]);
    const relay = new OutboxRelay(repo, bus);

    assert.doesNotThrow(() => relay.stop()); // stop before start
    relay.start(60_000);
    relay.start(60_000); // second start is a no-op, not a leaked interval
    relay.stop();
    relay.stop(); // double stop is safe
  });
});
