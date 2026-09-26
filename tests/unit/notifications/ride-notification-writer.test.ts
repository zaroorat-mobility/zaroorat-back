import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { writeNotificationPlan } from '../../../src/modules/rides/consumers/ride-notification.writer.js';
import {
  planNotifications,
  type NotificationLookups,
  type NotificationPlan,
} from '../../../src/modules/rides/consumers/ride-notification.planner.js';
import {
  EnqueueTimeoutError,
  closeQueues,
  notificationsQueue,
} from '../../../src/jobs/queues/index.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import type { EventEnvelope } from '../../../src/core/events';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import {
  CUSTOMER_USER,
  DRIVER,
  DRIVER_USER,
  DRIVERS,
  EVENT_ID,
  FUTURE,
  GOLDEN_SCENARIOS,
  PAST,
  RIDE,
  RIDES,
  envelopeFor,
  type GoldenFaults,
  type GoldenScenario,
  type GoldenStatusWrite,
} from './ride-notification.golden.js';

/// F3 S4 — the notification writer.
///
/// Part one runs planner → writer through every golden scenario, one write per
/// planned recipient with the failure isolated per recipient (as the consumer
/// does), and requires exactly the side effects the pre-F3 consumer was pinned
/// to: the same rows, enqueues, status writes and counters.
///
/// Part two is the writer's own contract: the plan's input reaches the
/// repository untouched, persistence errors propagate unchanged, an enqueue
/// failure is reported and never passed off as success, and the offer window is
/// judged at write time.

const PERSISTENCE_ERROR = new Error('simulated notification insert failure');
const STATUS_WRITE_ERROR = new Error('simulated status write failure');
const ENQUEUE_ERROR = new Error('simulated enqueue failure');

interface WriterFaults extends GoldenFaults {
  /// `updateDeliveryStatus` throws.
  statusWriteFails?: boolean;
  /// The repository returns no delivery row for a new notification.
  noDeliveryRow?: boolean;
  /// The repository enforces the idempotency key, as the unique index does.
  enforceUniqueKey?: boolean;
}

interface Observed {
  rideLookups: string[];
  driverLookups: string[];
  /// Clones of every insert input, in order.
  rows: unknown[];
  /// The input objects themselves, for identity checks.
  received: unknown[];
  enqueues: unknown[];
  statusWrites: GoldenStatusWrite[];
}

const observe = (): Observed => ({
  rideLookups: [],
  driverLookups: [],
  rows: [],
  received: [],
  enqueues: [],
  statusWrites: [],
});

function lookupsFor(faults: GoldenFaults, observed: Observed): NotificationLookups {
  return {
    async findRide(id) {
      observed.rideLookups.push(id);
      if (faults.rideLookupFailsOnCall?.includes(observed.rideLookups.length)) {
        throw new Error('simulated ride lookup failure');
      }
      const ride = RIDES[id];
      return ride ? { ...ride } : null;
    },
    async findDriver(id) {
      observed.driverLookups.push(id);
      if (faults.driverLookupFails) throw new Error('simulated driver lookup failure');
      const driver = DRIVERS[id];
      return driver ? { ...driver } : null;
    },
  };
}

/// The consumer golden harness's repository: attempt n is `notif-n` / `del-n`.
function repositoryFor(faults: WriterFaults, observed: Observed): NotificationRepository {
  const byKey = new Map<string, { id: string }>();
  return {
    async createNotificationWithDelivery(input: Record<string, unknown>) {
      observed.rows.push(structuredClone(input));
      observed.received.push(input);
      const n = observed.rows.length;
      if (faults.createFailsForUser === input.userId) throw PERSISTENCE_ERROR;
      const key = input.idempotencyKey as string;
      const existing = faults.enforceUniqueKey ? byKey.get(key) : undefined;
      if (existing) {
        return {
          notification: existing,
          delivery: { id: `del-of-${existing.id}` },
          isDuplicate: true,
        };
      }
      const notification = { id: `notif-${n}`, status: 'QUEUED', ...input };
      byKey.set(key, notification);
      return {
        notification,
        delivery: faults.noDeliveryRow
          ? null
          : { id: `del-${n}`, channel: 'PUSH', status: 'QUEUED' },
        isDuplicate: faults.createReturnsDuplicate === true,
      };
    },
    async updateDeliveryStatus(id: string, input: Record<string, unknown>) {
      observed.statusWrites.push({ kind: 'delivery', id, input: structuredClone(input) });
      if (faults.statusWriteFails) throw STATUS_WRITE_ERROR;
      return {};
    },
    async updateNotificationStatus(id: string, status: string) {
      observed.statusWrites.push({ kind: 'notification', id, status });
      return {};
    },
  } as unknown as NotificationRepository;
}

type AddMode = 'resolve' | 'reject' | 'hang';

/// Runs `work` with `add` on the memoised notifications queue replaced by a
/// recorder, restoring it whatever happens. `mode` may vary by call number.
async function withQueue<T>(
  mode: AddMode | ((call: number) => AddMode),
  observed: Observed,
  work: () => Promise<T>,
): Promise<T> {
  const queue = notificationsQueue();
  const realAdd = queue.add.bind(queue);
  (queue as unknown as Record<string, unknown>).add = async (
    name: string,
    data: unknown,
    opts: unknown,
  ) => {
    observed.enqueues.push(structuredClone({ name, data, opts }));
    const current = typeof mode === 'function' ? mode(observed.enqueues.length) : mode;
    if (current === 'reject') throw ENQUEUE_ERROR;
    if (current === 'hang') return new Promise<never>(() => {});
    return { id: (opts as { jobId: string }).jobId };
  };
  try {
    return await work();
  } finally {
    (queue as unknown as Record<string, unknown>).add = realAdd;
  }
}

function counter(name: string): number {
  return snapshotMetrics()
    .filter((sample) => sample.name === name)
    .reduce((sum, sample) => sum + sample.value, 0);
}

async function plansFor(
  type: string,
  data: Record<string, unknown>,
): Promise<{ envelope: EventEnvelope; plans: NotificationPlan[] }> {
  const envelope = envelopeFor({ type, data });
  const outcomes = await planNotifications(envelope, lookupsFor({}, observe()));
  return {
    envelope,
    plans: outcomes.flatMap((outcome) => (outcome.kind === 'notify' ? [outcome.plan] : [])),
  };
}

async function onePlan(type: string, data: Record<string, unknown>) {
  const { envelope, plans } = await plansFor(type, data);
  const [plan] = plans;
  assert.ok(plan, `${type} must plan a notification`);
  return { envelope, plan };
}

/// Per-recipient result of the golden pipeline. `threw` is a write that
/// rejected; every other value is the writer's outcome.
const WRITES_BY_ID: Readonly<Record<string, string[]>> = {
  G02: ['offer_expired'],
  G23: ['threw', 'enqueued'],
  G24: ['enqueued', 'threw'],
  G37: ['duplicate'],
  G38: ['enqueue_failed'],
  G39: ['threw'],
};

function expectedWrites(scenario: GoldenScenario): string[] {
  return WRITES_BY_ID[scenario.id] ?? scenario.expect.rows.map(() => 'enqueued');
}

after(async () => {
  await closeQueues();
});

describe('planner → writer reproduces the pre-F3 consumer (golden table)', () => {
  for (const scenario of GOLDEN_SCENARIOS) {
    it(`${scenario.id} · ${scenario.name}`, async () => {
      const observed = observe();
      const envelope = envelopeFor(scenario);
      const repository = repositoryFor(scenario.faults, observed);
      resetMetrics();

      const writes = await withQueue(
        scenario.faults.enqueueRejects ? 'reject' : 'resolve',
        observed,
        async () => {
          const outcomes = await planNotifications(envelope, lookupsFor(scenario.faults, observed));
          const results: string[] = [];
          // One write per recipient, each failure isolated — how the consumer
          // has always treated its recipients.
          for (const outcome of outcomes) {
            if (outcome.kind !== 'notify') continue;
            try {
              results.push((await writeNotificationPlan(envelope, outcome.plan, repository)).kind);
            } catch {
              results.push('threw');
            }
          }
          return results;
        },
      );

      const { expect } = scenario;
      assert.deepStrictEqual(observed.rideLookups, expect.rideLookups, 'ride lookups');
      assert.deepStrictEqual(observed.driverLookups, expect.driverLookups, 'driver lookups');
      assert.deepStrictEqual(observed.rows, expect.rows, 'notification rows');
      assert.deepStrictEqual(observed.enqueues, expect.enqueues, 'enqueues');
      assert.deepStrictEqual(observed.statusWrites, expect.statusWrites, 'status writes');
      assert.equal(counter('notification_created'), expect.created, 'notification_created');
      assert.equal(
        counter('notification_enqueue_failed'),
        expect.enqueueFailed,
        'notification_enqueue_failed',
      );
      assert.deepStrictEqual(writes, expectedWrites(scenario), 'writer outcomes');
    });
  }
});

describe('writeNotificationPlan — contract', () => {
  it('hands the planner’s input object to the repository untouched', async () => {
    const { envelope, plan } = await onePlan('ride.started', { rideId: RIDE });
    const observed = observe();
    await withQueue('resolve', observed, () =>
      writeNotificationPlan(envelope, plan, repositoryFor({}, observed)),
    );
    assert.equal(observed.received.length, 1);
    assert.strictEqual(observed.received[0], plan.input);
  });

  it('enqueues notification-delivery under the notification id, with the plan’s priority and the trace', async () => {
    const { envelope, plan } = await onePlan('ride.dispatch.offered', {
      dispatchId: 'd-1',
      requestId: 'r-1',
      driverId: DRIVER,
      expiresAt: FUTURE,
    });
    const observed = observe();
    const outcome = await withQueue('resolve', observed, () =>
      writeNotificationPlan(envelope, plan, repositoryFor({}, observed)),
    );
    assert.deepStrictEqual(outcome, {
      kind: 'enqueued',
      notificationId: 'notif-1',
      deliveryId: 'del-1',
    });
    assert.deepStrictEqual(observed.enqueues, [
      {
        name: 'notification-delivery',
        data: {
          notificationId: 'notif-1',
          deliveryId: 'del-1',
          eventId: EVENT_ID,
          eventType: 'ride.dispatch.offered',
          userId: DRIVER_USER,
          rideId: null,
          category: 'RIDE_OFFER',
        },
        opts: { jobId: 'notif-1', priority: 1 },
      },
    ]);
  });

  it('propagates a persistence failure unchanged, and enqueues and counts nothing', async () => {
    const { envelope, plan } = await onePlan('ride.started', { rideId: RIDE });
    const observed = observe();
    resetMetrics();
    await withQueue('resolve', observed, () =>
      assert.rejects(
        writeNotificationPlan(
          envelope,
          plan,
          repositoryFor({ createFailsForUser: CUSTOMER_USER }, observed),
        ),
        (err) => err === PERSISTENCE_ERROR,
      ),
    );
    assert.deepStrictEqual(observed.enqueues, []);
    assert.equal(counter('notification_created'), 0);
    assert.equal(counter('notification_enqueue_failed'), 0);
  });

  it('propagates a failure to settle an expired offer, and enqueues nothing', async () => {
    const { envelope, plan } = await onePlan('ride.dispatch.offered', {
      dispatchId: 'd-1',
      requestId: 'r-1',
      driverId: DRIVER,
      expiresAt: PAST,
    });
    const observed = observe();
    await withQueue('resolve', observed, () =>
      assert.rejects(
        writeNotificationPlan(envelope, plan, repositoryFor({ statusWriteFails: true }, observed)),
        (err) => err === STATUS_WRITE_ERROR,
      ),
    );
    assert.deepStrictEqual(observed.enqueues, []);
    assert.deepStrictEqual(
      observed.statusWrites.map((w) => w.kind),
      ['delivery'],
      'the notification status is not written after the delivery write failed',
    );
  });

  it('reports a rejected enqueue as enqueue_failed — never success — and leaves the row QUEUED', async () => {
    const { envelope, plan } = await onePlan('ride.started', { rideId: RIDE });
    const observed = observe();
    resetMetrics();
    const outcome = await withQueue('reject', observed, () =>
      writeNotificationPlan(envelope, plan, repositoryFor({}, observed)),
    );
    assert.deepStrictEqual(outcome, {
      kind: 'enqueue_failed',
      notificationId: 'notif-1',
      deliveryId: 'del-1',
      error: ENQUEUE_ERROR,
    });
    assert.strictEqual((outcome as { error: unknown }).error, ENQUEUE_ERROR);
    assert.equal(observed.rows.length, 1, 'the row was persisted');
    assert.deepStrictEqual(observed.statusWrites, [], 'nothing marks it failed: PA-11 recovers it');
    assert.equal(counter('notification_created'), 1);
    assert.equal(counter('notification_enqueue_failed'), 1);
  });

  it(
    'bounds an enqueue that never settles and reports it as enqueue_failed',
    { timeout: 15_000 },
    async () => {
      const { envelope, plan } = await onePlan('ride.started', { rideId: RIDE });
      const observed = observe();
      resetMetrics();
      const started = Date.now();
      const outcome = await withQueue('hang', observed, () =>
        writeNotificationPlan(envelope, plan, repositoryFor({}, observed)),
      );
      const elapsed = Date.now() - started;
      assert.equal(outcome.kind, 'enqueue_failed');
      assert.ok((outcome as { error: unknown }).error instanceof EnqueueTimeoutError);
      assert.ok(elapsed >= 1_900 && elapsed < 10_000, `released at ~2s, took ${elapsed}ms`);
      assert.equal(counter('notification_enqueue_failed'), 1);
    },
  );

  it('a duplicate — or a notification with no delivery row — enqueues and counts nothing', async () => {
    for (const faults of [{ createReturnsDuplicate: true }, { noDeliveryRow: true }]) {
      const { envelope, plan } = await onePlan('ride.started', { rideId: RIDE });
      const observed = observe();
      resetMetrics();
      const outcome = await withQueue('resolve', observed, () =>
        writeNotificationPlan(envelope, plan, repositoryFor(faults, observed)),
      );
      assert.deepStrictEqual(outcome, { kind: 'duplicate', notificationId: 'notif-1' });
      assert.deepStrictEqual(observed.enqueues, []);
      assert.deepStrictEqual(observed.statusWrites, []);
      assert.equal(counter('notification_created'), 0);
    }
  });

  it('is idempotent on the key: the same plan twice is one row and one job; two recipients are two', async () => {
    const { envelope, plan } = await onePlan('ride.started', { rideId: RIDE });
    const observed = observe();
    const repository = repositoryFor({ enforceUniqueKey: true }, observed);
    const outcomes = await withQueue('resolve', observed, async () => [
      await writeNotificationPlan(envelope, plan, repository),
      await writeNotificationPlan(envelope, plan, repository),
    ]);
    assert.deepStrictEqual(
      outcomes.map((o) => o.kind),
      ['enqueued', 'duplicate'],
    );
    assert.equal(observed.enqueues.length, 1);

    const cancelled = await plansFor('ride.cancelled', { rideId: RIDE, cancelledBy: 'customer' });
    const both = observe();
    const perRecipient = repositoryFor({ enforceUniqueKey: true }, both);
    const kinds = await withQueue('resolve', both, async () => {
      const results: string[] = [];
      for (const p of cancelled.plans) {
        results.push((await writeNotificationPlan(cancelled.envelope, p, perRecipient)).kind);
      }
      return results;
    });
    assert.deepStrictEqual(kinds, ['enqueued', 'enqueued']);
  });

  it('judges the offer window at write time: 0ms left is expired, 1ms left is sent', async (t) => {
    const now = Date.parse('2026-09-25T10:00:30.000Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    for (const [expiresAt, kind] of [
      [new Date(now).toISOString(), 'offer_expired'],
      [new Date(now + 1).toISOString(), 'enqueued'],
    ] as const) {
      const { envelope, plan } = await onePlan('ride.dispatch.offered', {
        dispatchId: 'd-1',
        requestId: 'r-1',
        driverId: DRIVER,
        expiresAt,
      });
      const observed = observe();
      const outcome = await withQueue('resolve', observed, () =>
        writeNotificationPlan(envelope, plan, repositoryFor({}, observed)),
      );
      assert.equal(outcome.kind, kind, expiresAt);
      assert.equal(observed.enqueues.length, kind === 'enqueued' ? 1 : 0);
    }
  });

  it('isolates recipients: one recipient’s failed enqueue does not affect the next', async () => {
    const { envelope, plans } = await plansFor('ride.cancelled', {
      rideId: RIDE,
      cancelledBy: 'customer',
    });
    assert.equal(plans.length, 2);
    const observed = observe();
    const repository = repositoryFor({}, observed);
    resetMetrics();
    const kinds = await withQueue(
      (call) => (call === 1 ? 'reject' : 'resolve'),
      observed,
      async () => {
        const results: string[] = [];
        for (const plan of plans) {
          results.push((await writeNotificationPlan(envelope, plan, repository)).kind);
        }
        return results;
      },
    );
    assert.deepStrictEqual(kinds, ['enqueue_failed', 'enqueued']);
    assert.deepStrictEqual(
      observed.enqueues.map((e) => (e as { data: { userId: string } }).data.userId),
      [CUSTOMER_USER, DRIVER_USER],
    );
    assert.equal(counter('notification_created'), 2);
    assert.equal(counter('notification_enqueue_failed'), 1);
  });
});
