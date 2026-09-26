import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EnqueueTimeoutError,
  raceWithTimeout,
  RideNotificationConsumer,
} from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../../src/modules/drivers/repositories/driver.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';

/// PA-1 SCOPE CORRECTION — bounded notification queue enqueue.
///
/// `createQueueConnection` uses `maxRetriesPerRequest: null`, so during a Redis
/// outage `queue.add()` stays pending forever instead of rejecting. That pending
/// promise was awaited by this consumer, which is awaited by `EventBus.emit`,
/// which is awaited by `OutboxRelay.dispatch` — and the relay walks its batch
/// serially, so one unreachable Redis stalled all outbox progress, including the
/// Socket.IO bridge for unrelated events.
///
/// These tests pin the bound itself. They need no Redis, which is the point: the
/// behaviour under test is what happens when Redis is *not* there.

function counter(name: string): number {
  const sample = snapshotMetrics().find((s) => s.name === name);
  return sample ? sample.value : 0;
}

describe('raceWithTimeout — the enqueue bound', () => {
  // (a) + (b) success still succeeds, including when it lands just inside the bound
  it('resolves with the underlying value when the work settles first', async () => {
    const result = await raceWithTimeout(Promise.resolve('job-1'), 1000);
    assert.equal(result, 'job-1');
  });

  it('resolves when the work completes before the timeout elapses', async () => {
    const slowButFine = new Promise<string>((resolve) => setTimeout(() => resolve('job-2'), 20));
    const result = await raceWithTimeout(slowButFine, 500);
    assert.equal(result, 'job-2');
  });

  // (c) exceeding the bound rejects
  it('rejects with EnqueueTimeoutError when the work exceeds the timeout', async () => {
    const neverSettles = new Promise<string>(() => {});
    await assert.rejects(
      () => raceWithTimeout(neverSettles, 30),
      (err: unknown) => {
        assert.ok(err instanceof EnqueueTimeoutError, 'must be an EnqueueTimeoutError');
        assert.match((err as Error).message, /did not settle within 30ms/);
        return true;
      },
    );
  });

  // (f) the caller is not blocked indefinitely
  it('returns control to the caller promptly rather than pending forever', async () => {
    const neverSettles = new Promise<string>(() => {});
    const started = Date.now();
    await assert.rejects(() => raceWithTimeout(neverSettles, 50));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `caller must be released promptly, waited ${elapsed}ms`);
  });

  // An underlying rejection still propagates — the bound must not mask real errors
  it('propagates a genuine rejection from the work unchanged', async () => {
    const boom = new Error('ECONNREFUSED');
    await assert.rejects(
      () => raceWithTimeout(Promise.reject(boom), 1000),
      (err: unknown) => {
        assert.equal(err, boom, 'the original error must reach the caller, not a timeout');
        return true;
      },
    );
  });

  // (9) a late settlement must not become an unhandled rejection
  it('does not raise an unhandled rejection when the work rejects after the timeout', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      // Rejects well after it has already lost the race.
      const lateFailure = new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late redis failure')), 40);
      });

      await assert.rejects(() => raceWithTimeout(lateFailure, 10), EnqueueTimeoutError);

      // Give the late rejection time to land and any unhandled-rejection
      // bookkeeping a turn to run.
      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.deepEqual(seen, [], 'a post-timeout rejection must be absorbed, not escalated');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not leave a timer holding the event loop open after success', async () => {
    // A leaked, un-cleared timer would keep the worker alive past shutdown.
    // clearTimeout in the `finally` plus unref is what prevents it; this asserts
    // the happy path does not regress into leaking one.
    const before = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    await raceWithTimeout(Promise.resolve('ok'), 60_000);
    const after = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    assert.ok(after <= before, `timer leaked: ${before} → ${after}`);
  });
});

/// The consumer-level consequences of a failed enqueue.
///
/// ## Why this no longer depends on Redis being down
///
/// These cases originally drove the consumer with no Redis running and let the
/// real `queue.add()` time out. That made them environment-dependent in the worst
/// way: they passed on a laptop with Redis stopped and failed in CI with Redis
/// available, because a reachable Redis accepts the job and there is no failure
/// left to assert. The counter read 0 where the test wanted 1.
///
/// The failure is now injected instead. `notificationsQueue()` memoises one Queue
/// instance, so the test takes that instance and replaces its `add` for the
/// duration of the call — the same technique the PA-7 suite uses on the logger.
/// `add` never reaches Redis, so the outcome is identical whether Redis is up or
/// down, which is the property that was missing.
///
/// The 2-second bound itself is covered by the `raceWithTimeout` suite above,
/// against synthetic promises and without any queue at all.
describe('enqueue failure is recoverable, not terminal', () => {
  type AddFailure = 'reject' | 'hang';

  /// Replaces `add` on the memoised notifications queue, runs the consumer for
  /// one `ride.started` event, and restores `add` whatever happens.
  async function runWithFailingEnqueue(mode: AddFailure): Promise<{
    created: Array<Record<string, unknown>>;
    addCalls: number;
    elapsedMs: number;
  }> {
    const { notificationsQueue } = await import('../../../src/jobs/queues/index.js');
    const queue = notificationsQueue();
    const realAdd = queue.add.bind(queue);
    let addCalls = 0;

    (queue as unknown as Record<string, unknown>).add = async (): Promise<never> => {
      addCalls += 1;
      if (mode === 'reject') {
        // What a Redis that answers-and-refuses looks like.
        throw new Error('simulated enqueue failure: connection refused');
      }
      // What `maxRetriesPerRequest: null` actually does during an outage: never
      // settles. The PA-1 bound is what turns this into a failure.
      return new Promise<never>(() => {});
    };

    const created: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, (e: EventEnvelope) => Promise<void>>();

    const eventBusStub = {
      on(type: string, handler: (e: EventEnvelope) => Promise<void>) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    } as unknown as EventBus;

    const rideRepoStub = {
      async findById() {
        return { id: 'ride-1', customerId: 'cust-1', driverId: null, status: 'ACCEPTED' };
      },
    } as unknown as RideRepository;

    const notificationRepoStub = {
      async createNotificationWithDelivery(input: Record<string, unknown>) {
        // Mirrors the repository: both rows are born QUEUED.
        const record = { id: 'notif-1', status: 'QUEUED', ...input };
        created.push(record);
        return {
          notification: record,
          delivery: { id: 'del-1', channel: 'PUSH', status: 'QUEUED' },
          isDuplicate: false,
        };
      },
    } as unknown as NotificationRepository;

    const consumer = new RideNotificationConsumer(
      eventBusStub,
      rideRepoStub,
      {} as unknown as DriverRepository,
      {} as unknown as DeviceRepository,
      notificationRepoStub,
    );
    consumer.register();

    const handler = handlers.get('ride.started');
    assert.ok(handler);

    const started = Date.now();
    try {
      await handler({
        eventId: 'evt-enqueue-fail-1',
        type: 'ride.started',
        producer: 'rides',
        occurredAt: '2026-09-23T10:00:00.000Z',
        data: { rideId: 'ride-1' },
      } as unknown as EventEnvelope);
    } finally {
      (queue as unknown as Record<string, unknown>).add = realAdd;
    }

    return { created, addCalls, elapsedMs: Date.now() - started };
  }

  it('counts the failure and leaves the notification QUEUED and recoverable', async () => {
    resetMetrics();

    const { created, addCalls } = await runWithFailingEnqueue('reject');

    assert.equal(addCalls, 1, 'the enqueue must have been attempted exactly once');

    // The row was persisted and nothing marked it failed, so the PA-11
    // reconciliation sweep can still find and re-enqueue it. That is the whole
    // recovery story: a Redis blip becomes a delay, not a lost notification.
    assert.equal(created.length, 1, 'the notification row must still be created');
    assert.equal(created[0]?.status, 'QUEUED');

    assert.equal(
      counter('notification_enqueue_failed'),
      1,
      'notification_enqueue_failed must increment exactly once',
    );

    // Both counters together are what makes the gap visible: the notification
    // exists, it simply is not queued yet.
    assert.equal(counter('notification_created'), 1);
  });

  it('does not throw out of the consumer — notification failure stays isolated', async () => {
    resetMetrics();
    // Throwing here would fail the outbox row and redeliver a domain event whose
    // ride work is already committed.
    await assert.doesNotReject(() => runWithFailingEnqueue('reject'));
  });

  it('raises no unhandled rejection when the enqueue fails', async () => {
    resetMetrics();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await runWithFailingEnqueue('reject');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(seen, [], 'the rejection must be absorbed by the consumer, not escalated');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('bounds a never-settling enqueue and still records it as a failure', async () => {
    // The outage shape that started all of this: `add` pending forever. Without
    // the bound the consumer never returns and the outbox relay stalls behind it.
    resetMetrics();

    const { created, elapsedMs } = await runWithFailingEnqueue('hang');

    assert.ok(
      elapsedMs >= 1_900 && elapsedMs < 10_000,
      `must be released at roughly the 2s bound, took ${elapsedMs}ms`,
    );
    assert.equal(created[0]?.status, 'QUEUED');
    assert.equal(counter('notification_enqueue_failed'), 1);
  });
});
