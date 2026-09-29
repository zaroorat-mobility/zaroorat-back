import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RideNotificationConsumer } from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import { closeQueues, notificationsQueue } from '../../../src/jobs/queues/index.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../../src/modules/drivers/repositories/driver.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import {
  DRIVERS,
  GOLDEN_SCENARIOS,
  NOTIFICATION_EVENT_TYPES,
  RIDES,
  envelopeFor,
  type GoldenFaults,
  type GoldenScenario,
  type GoldenStatusWrite,
} from './ride-notification.golden.js';

/// F3 parity baseline (S1). Drives the real RideNotificationConsumer through
/// every golden scenario and records everything it does: lookups, inserts,
/// status writes, enqueues and counters. Only the edges are stubbed — the
/// repositories, and `add` on the memoised notifications queue, so nothing
/// reaches Redis and the outcome is the same whether Redis is up or down.

type Handler = (envelope: EventEnvelope) => Promise<void>;

interface Observed {
  rideLookups: string[];
  driverLookups: string[];
  rows: unknown[];
  enqueues: unknown[];
  statusWrites: GoldenStatusWrite[];
}

function makeConsumer(faults: GoldenFaults, observed: Observed): Map<string, Handler> {
  const handlers = new Map<string, Handler>();

  const eventBus = {
    on(type: string, handler: Handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  } as unknown as EventBus;

  const rideRepository = {
    async findById(id: string) {
      observed.rideLookups.push(id);
      if (faults.rideLookupFailsOnCall?.includes(observed.rideLookups.length)) {
        throw new Error('simulated ride lookup failure');
      }
      const ride = RIDES[id];
      return ride ? { id, status: 'ACCEPTED', ...ride } : null;
    },
  } as unknown as RideRepository;

  const driverRepository = {
    async findById(id: string) {
      observed.driverLookups.push(id);
      if (faults.driverLookupFails) throw new Error('simulated driver lookup failure');
      const driver = DRIVERS[id];
      return driver ? { id, ...driver } : null;
    },
  } as unknown as DriverRepository;

  const notificationRepository = {
    async createNotificationWithDelivery(input: Record<string, unknown>) {
      observed.rows.push(structuredClone(input));
      const n = observed.rows.length;
      if (faults.createFailsForUser === input.userId) {
        throw new Error('simulated notification insert failure');
      }
      return {
        notification: { id: `notif-${n}`, status: 'QUEUED', ...input },
        delivery: { id: `del-${n}`, channel: 'PUSH', status: 'QUEUED' },
        isDuplicate: faults.createReturnsDuplicate === true,
      };
    },
    async updateDeliveryStatus(id: string, input: Record<string, unknown>) {
      observed.statusWrites.push({ kind: 'delivery', id, input: structuredClone(input) });
      return {};
    },
    async updateNotificationStatus(id: string, status: string) {
      observed.statusWrites.push({ kind: 'notification', id, status });
      return {};
    },
  } as unknown as NotificationRepository;

  new RideNotificationConsumer(
    eventBus,
    rideRepository,
    driverRepository,
    {} as unknown as DeviceRepository,
    notificationRepository,
  ).register();
  return handlers;
}

function counter(name: string): number {
  return snapshotMetrics()
    .filter((sample) => sample.name === name)
    .reduce((sum, sample) => sum + sample.value, 0);
}

/// Runs one scenario with `add` replaced by a recorder, restoring it whatever
/// happens.
async function drive(
  scenario: GoldenScenario,
): Promise<Observed & { created: number; enqueueFailed: number }> {
  const observed: Observed = {
    rideLookups: [],
    driverLookups: [],
    rows: [],
    enqueues: [],
    statusWrites: [],
  };
  const handler = makeConsumer(scenario.faults, observed).get(scenario.type);
  assert.ok(handler, `consumer must subscribe to ${scenario.type}`);

  const queue = notificationsQueue();
  const realAdd = queue.add.bind(queue);
  (queue as unknown as Record<string, unknown>).add = async (
    name: string,
    data: unknown,
    opts: unknown,
  ) => {
    observed.enqueues.push(structuredClone({ name, data, opts }));
    if (scenario.faults.enqueueRejects) throw new Error('simulated enqueue failure');
    return { id: (opts as { jobId: string }).jobId };
  };

  resetMetrics();
  try {
    // A notification failure must never escape: throwing here would fail the
    // outbox row and redeliver a ride or payment event that already committed.
    await assert.doesNotReject(handler(envelopeFor(scenario)));
  } finally {
    (queue as unknown as Record<string, unknown>).add = realAdd;
  }

  return {
    ...observed,
    created: counter('notification_created'),
    enqueueFailed: counter('notification_enqueue_failed'),
  };
}

describe('RideNotificationConsumer — F3 golden parity baseline', () => {
  after(async () => {
    await closeQueues();
  });

  it('subscribes exactly the ten notification event types', () => {
    const handlers = makeConsumer(
      {},
      { rideLookups: [], driverLookups: [], rows: [], enqueues: [], statusWrites: [] },
    );
    assert.deepEqual([...handlers.keys()].sort(), [...NOTIFICATION_EVENT_TYPES].sort());
  });

  /// Added in S3, so the planner's matching test is a parity claim. With no
  /// `data` the handler throws before any lookup or write, which fails the
  /// outbox dispatch rather than silently publishing the event.
  it('rejects when envelope.data is missing, for every event, touching nothing', async () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const observed: Observed = {
        rideLookups: [],
        driverLookups: [],
        rows: [],
        enqueues: [],
        statusWrites: [],
      };
      const handler = makeConsumer({}, observed).get(type);
      assert.ok(handler, type);
      await assert.rejects(
        handler(envelopeFor({ type, data: null as unknown as Record<string, unknown> })),
        TypeError,
        type,
      );
      assert.deepStrictEqual(
        observed,
        { rideLookups: [], driverLookups: [], rows: [], enqueues: [], statusWrites: [] },
        type,
      );
    }
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    it(`${scenario.id} · ${scenario.name}`, async () => {
      const actual = await drive(scenario);
      const { expect } = scenario;
      assert.deepStrictEqual(actual.rideLookups, expect.rideLookups, 'ride lookups');
      assert.deepStrictEqual(actual.driverLookups, expect.driverLookups, 'driver lookups');
      assert.deepStrictEqual(actual.rows, expect.rows, 'notification rows');
      assert.deepStrictEqual(actual.enqueues, expect.enqueues, 'enqueues');
      assert.deepStrictEqual(actual.statusWrites, expect.statusWrites, 'status writes');
      assert.equal(actual.created, expect.created, 'notification_created');
      assert.equal(actual.enqueueFailed, expect.enqueueFailed, 'notification_enqueue_failed');
    });
  }
});
