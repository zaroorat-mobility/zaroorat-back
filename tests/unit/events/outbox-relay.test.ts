import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OutboxRelay } from '../../../src/core/events/OutboxRelay.js';
import { OutboxMetrics } from '../../../src/core/events/OutboxMetrics.js';
import type { EventBus, DeliveryResult } from '../../../src/core/events/EventBus.js';
import type {
  ClaimedOutboxEvent,
  OutboxRepository,
} from '../../../src/core/events/OutboxRepository.js';
import type { EventEnvelope } from '../../../src/core/events/types.js';

const CLAIM_TOKEN = '00000000-0000-0000-0000-0000000000aa';

const claimed = (id: string, retries = 0): ClaimedOutboxEvent => ({
  id,
  eventType: 'auth.login.succeeded',
  retries,
  claimToken: CLAIM_TOKEN,
  payload: {
    eventId: `evt-${id}`,
    type: 'auth.login.succeeded',
    version: 1,
    envelopeVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'auth',
    subject: { userId: 'u1' },
    correlation: { requestId: null, sessionId: null },
    data: {},
  },
});

interface RetryCall {
  id: string;
  error: string;
  nextAttemptAt: Date;
}

function makeRepo(rows: ClaimedOutboxEvent[], owned = true) {
  const published: string[] = [];
  const retried: RetryCall[] = [];
  const dead: string[] = [];
  const released: string[] = [];
  let claims = 0;

  const repo = {
    claimBatch: async (limit: number) => {
      claims += 1;

      return claims === 1 ? rows.slice(0, limit) : [];
    },
    markPublished: async (ids: string[], token: string) => {
      if (!owned || token !== CLAIM_TOKEN) return 0;
      published.push(...ids);
      return ids.length;
    },
    releaseForRetry: async (id: string, token: string, error: string, nextAttemptAt: Date) => {
      if (!owned || token !== CLAIM_TOKEN) return 0;
      retried.push({ id, error, nextAttemptAt });
      return 1;
    },
    markDead: async (id: string, token: string) => {
      if (!owned || token !== CLAIM_TOKEN) return 0;
      dead.push(id);
      return 1;
    },
    releaseUnprocessed: async (ids: string[], token: string) => {
      if (token !== CLAIM_TOKEN) return 0;
      released.push(...ids);
      return ids.length;
    },
    reclaimStale: async () => 0,
    prunePublished: async () => 0,
    stats: async () => ({ pending: 0, dead: 0, oldestPendingAgeMs: 0 }),
  } as unknown as OutboxRepository;

  return { repo, published, retried, dead, released };
}

const busDelivering = (result: DeliveryResult = { delivered: 1, failures: [] }) =>
  ({ emit: async () => result }) as unknown as EventBus;

const relay = (repo: OutboxRepository, bus: EventBus) =>
  new OutboxRelay(repo, bus, new OutboxMetrics());

describe('OutboxRelay.processBatch', () => {
  it('dispatches each claimed event to the bus and marks it published', async () => {
    const emitted: EventEnvelope[] = [];
    const bus = {
      emit: async (envelope: EventEnvelope) => {
        emitted.push(envelope);
        return { delivered: 1, failures: [] };
      },
    } as unknown as EventBus;
    const { repo, published, retried, dead } = makeRepo([claimed('1'), claimed('2')]);

    const result = await relay(repo, bus).processBatch(10);

    assert.equal(result.claimed, 2);
    assert.equal(result.published, 2);
    assert.deepEqual(
      emitted.map((e) => e.eventId),
      ['evt-1', 'evt-2'],
    );
    assert.deepEqual(published, ['1', '2']);
    assert.deepEqual(retried, []);
    assert.deepEqual(dead, []);
  });

  it('returns a failed event to the queue for another attempt, never retiring it', async () => {
    const bus = busDelivering({ delivered: 0, failures: [new Error('consumer down')] });
    const { repo, published, retried, dead } = makeRepo([claimed('7')]);

    const result = await relay(repo, bus).processBatch(10);

    assert.deepEqual(published, []);
    assert.deepEqual(dead, []);
    assert.equal(result.retried, 1);
    assert.equal(retried.length, 1);
    assert.equal(retried[0]?.id, '7');
    assert.match(retried[0]?.error ?? '', /consumer down/);
  });

  it('backs the next attempt off into the future', async () => {
    const bus = busDelivering({ delivered: 0, failures: [new Error('nope')] });
    const { repo, retried } = makeRepo([claimed('8', 2)]);

    const before = Date.now();
    await relay(repo, bus).processBatch(10);

    assert.ok(
      (retried[0]?.nextAttemptAt.getTime() ?? 0) >= before,
      'next attempt must not be scheduled in the past',
    );
  });

  it('does not retire an event when only some subscribers succeed', async () => {
    const bus = busDelivering({ delivered: 2, failures: [new Error('one consumer failed')] });
    const { repo, published, retried } = makeRepo([claimed('9')]);

    await relay(repo, bus).processBatch(10);

    assert.deepEqual(published, []);
    assert.equal(retried.length, 1);
  });

  it('dead-letters an event that has exhausted its attempt budget', async () => {
    const bus = busDelivering({ delivered: 0, failures: [new Error('poison')] });

    const { repo, published, retried, dead } = makeRepo([claimed('13', 7)]);

    const result = await relay(repo, bus).processBatch(10);

    assert.deepEqual(dead, ['13']);
    assert.deepEqual(published, []);
    assert.deepEqual(retried, []);
    assert.equal(result.deadLettered, 1);
  });

  it('treats a thrown bus as a failure rather than losing the batch', async () => {
    const bus = {
      emit: async () => {
        throw new Error('bus down');
      },
    } as unknown as EventBus;
    const { repo, published, retried } = makeRepo([claimed('21')]);

    await relay(repo, bus).processBatch(10);

    assert.deepEqual(published, []);
    assert.equal(retried.length, 1);
  });

  it('isolates one event failure from the rest of the batch', async () => {
    let call = 0;
    const bus = {
      emit: async () => {
        call += 1;
        return call === 2
          ? { delivered: 0, failures: [new Error('bad')] }
          : { delivered: 1, failures: [] };
      },
    } as unknown as EventBus;
    const { repo, published, retried } = makeRepo([claimed('1'), claimed('2'), claimed('3')]);

    await relay(repo, bus).processBatch(10);

    assert.deepEqual(published, ['1', '3']);
    assert.deepEqual(
      retried.map((r) => r.id),
      ['2'],
    );
  });

  it('returns zero and does nothing when the outbox is empty', async () => {
    const { repo } = makeRepo([]);
    const result = await relay(repo, busDelivering()).processBatch(10);

    assert.deepEqual(result, {
      claimed: 0,
      published: 0,
      retried: 0,
      deadLettered: 0,
      abandoned: 0,
    });
  });
});

describe('OutboxRelay when its claim was reaped mid-batch', () => {
  it('does not report events published that the database refused to retire', async () => {
    const { repo, published } = makeRepo([claimed('1'), claimed('2')], false);

    const result = await relay(repo, busDelivering()).processBatch(10);

    assert.deepEqual(published, [], 'the write is rejected by the ownership filter');
    assert.equal(result.published, 0, 'and the count must reflect the database, not the dispatch');
  });

  it('does not count a retry it was not allowed to schedule', async () => {
    const bus = busDelivering({ delivered: 0, failures: [new Error('nope')] });
    const { repo, retried } = makeRepo([claimed('1')], false);

    const result = await relay(repo, bus).processBatch(10);

    assert.deepEqual(retried, []);
    assert.equal(result.retried, 0);
  });

  it('does not count a dead-letter it was not allowed to write', async () => {
    const bus = busDelivering({ delivered: 0, failures: [new Error('poison')] });
    const { repo, dead } = makeRepo([claimed('1', 7)], false);

    const result = await relay(repo, bus).processBatch(10);

    assert.deepEqual(dead, []);
    assert.equal(result.deadLettered, 0);
  });
});

describe('OutboxRelay start/stop', () => {
  it('is idempotent to start and safe to stop without a running timer', async () => {
    const { repo } = makeRepo([]);
    const instance = relay(repo, busDelivering());

    await instance.stop();
    instance.start(60_000);
    instance.start(60_000);
    await instance.stop();
    await instance.stop();
  });

  it('waits for the tick in flight before resolving', async () => {
    let dispatching = false;
    let finished = false;
    const bus = {
      emit: async () => {
        dispatching = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        finished = true;
        return { delivered: 1, failures: [] };
      },
    } as unknown as EventBus;
    const { repo } = makeRepo([claimed('1')]);
    const instance = relay(repo, bus);

    instance.start(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(dispatching, true, 'precondition: a tick is in flight');

    await instance.stop();
    assert.equal(finished, true, 'stop() must not abandon the batch it interrupted');
  });

  it('stops between events and releases the tail it never dispatched', async () => {
    const dispatched: string[] = [];
    const { repo, published, released } = makeRepo([
      claimed('1'),
      claimed('2'),
      claimed('3'),
      claimed('4'),
    ]);
    const instance = relay(repo, {
      emit: async (envelope: EventEnvelope) => {
        dispatched.push(envelope.eventId);

        if (dispatched.length === 1) void instance.stop();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { delivered: 1, failures: [] };
      },
    } as unknown as EventBus);

    const result = await instance.processBatch(10);

    assert.deepEqual(dispatched, ['evt-1'], 'no event may start after stop() is requested');
    assert.deepEqual(published, ['1'], 'the one that finished is still retired');
    assert.deepEqual(released, ['2', '3', '4'], 'the tail goes back for the next pod');
    assert.equal(result.abandoned, 3);
  });

  it('gives up waiting rather than blocking shutdown on a hung subscriber', async () => {
    const { repo } = makeRepo([claimed('1')]);
    const instance = relay(repo, {
      emit: () => new Promise(() => {}),
    } as unknown as EventBus);

    instance.start(1);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const started = Date.now();
    await instance.stop(20);
    const waited = Date.now() - started;

    assert.ok(waited >= 20, 'it waits for the deadline it was given');
    assert.ok(waited < 5_000, 'and then returns, rather than blocking shutdown forever');
  });
});
