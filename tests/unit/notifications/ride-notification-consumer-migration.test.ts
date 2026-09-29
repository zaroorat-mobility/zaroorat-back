import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { RideNotificationConsumer } from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import { closeQueues, notificationsQueue } from '../../../src/jobs/queues/index.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import { logger } from '../../../src/shared/logger/index.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../../src/modules/drivers/repositories/driver.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import {
  CUSTOMER_USER,
  DRIVER,
  DRIVER_USER,
  DRIVERS,
  EVENT_ID,
  NOTIFICATION_EVENT_TYPES,
  OCCURRED_AT,
  RIDE,
  RIDES,
  envelopeFor,
} from './ride-notification.golden.js';

/// F3 S5 — the consumer migrated to planner → writer.
///
/// The golden suite proves the migrated consumer's side effects are unchanged.
/// This suite pins what that cannot see, and names each migration hazard in one
/// place: recipient order and call sequence, per-recipient isolation of every
/// failure kind (including a per-recipient enqueue failure), `enqueue_failed`
/// staying an outcome rather than becoming an error, the missing-`data` rejection,
/// the exact identity of each write, and that the consumer keeps no notification
/// policy of its own.

type Handler = (envelope: EventEnvelope) => Promise<void>;
type AddMode = 'resolve' | 'reject';

interface Faults {
  rideLookupFailsOnCall?: number[];
  createFailsForUser?: string;
  /// Queue behaviour by `add` call number (1-based).
  enqueue?: (call: number) => AddMode;
}

interface Run {
  /// Every lookup and write, interleaved, in the order it happened.
  calls: string[];
  rows: Array<Record<string, unknown>>;
  enqueues: Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }>;
  statusWrites: string[];
  logs: Array<{ level: 'warn' | 'error'; msg: string; fields: Record<string, unknown> }>;
  created: number;
  enqueueFailed: number;
}

function counter(name: string): number {
  return snapshotMetrics()
    .filter((sample) => sample.name === name)
    .reduce((sum, sample) => sum + sample.value, 0);
}

async function consume(
  type: string,
  data: Record<string, unknown>,
  faults: Faults = {},
): Promise<Run> {
  const run: Run = {
    calls: [],
    rows: [],
    enqueues: [],
    statusWrites: [],
    logs: [],
    created: 0,
    enqueueFailed: 0,
  };
  const handlers = new Map<string, Handler>();
  let rideCalls = 0;

  new RideNotificationConsumer(
    {
      on(eventType: string, handler: Handler) {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      },
    } as unknown as EventBus,
    {
      async findById(id: string) {
        rideCalls += 1;
        run.calls.push(`ride:${id}`);
        if (faults.rideLookupFailsOnCall?.includes(rideCalls)) {
          throw new Error('simulated ride lookup failure');
        }
        const ride = RIDES[id];
        return ride ? { id, ...ride } : null;
      },
    } as unknown as RideRepository,
    {
      async findById(id: string) {
        run.calls.push(`driver:${id}`);
        const driver = DRIVERS[id];
        return driver ? { id, ...driver } : null;
      },
    } as unknown as DriverRepository,
    {} as unknown as DeviceRepository,
    {
      async createNotificationWithDelivery(input: Record<string, unknown>) {
        run.rows.push(structuredClone(input));
        const n = run.rows.length;
        run.calls.push(`insert:${String(input.userId)}`);
        if (faults.createFailsForUser === input.userId) {
          throw new Error('simulated notification insert failure');
        }
        return {
          notification: { id: `notif-${n}`, status: 'QUEUED', ...input },
          delivery: { id: `del-${n}`, channel: 'PUSH', status: 'QUEUED' },
          isDuplicate: false,
        };
      },
      async updateDeliveryStatus(id: string) {
        run.statusWrites.push(`delivery:${id}`);
        return {};
      },
      async updateNotificationStatus(id: string, status: string) {
        run.statusWrites.push(`notification:${id}:${status}`);
        return {};
      },
    } as unknown as NotificationRepository,
  ).register();

  const handler = handlers.get(type);
  assert.ok(handler, `consumer must subscribe to ${type}`);

  const queue = notificationsQueue();
  const realAdd = queue.add.bind(queue);
  (queue as unknown as Record<string, unknown>).add = async (
    name: string,
    jobData: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => {
    run.enqueues.push(structuredClone({ name, data: jobData, opts }));
    run.calls.push(`enqueue:${String(opts.jobId)}`);
    if ((faults.enqueue?.(run.enqueues.length) ?? 'resolve') === 'reject') {
      throw new Error('simulated enqueue failure');
    }
    return { id: opts.jobId };
  };
  const realWarn = logger.warn;
  const realError = logger.error;
  const record =
    (level: 'warn' | 'error') =>
    (fields: Record<string, unknown>, msg: string): void => {
      run.logs.push({ level, msg, fields });
    };
  logger.warn = record('warn') as unknown as typeof logger.warn;
  logger.error = record('error') as unknown as typeof logger.error;

  resetMetrics();
  try {
    await handler(envelopeFor({ type, data }));
  } finally {
    (queue as unknown as Record<string, unknown>).add = realAdd;
    logger.warn = realWarn;
    logger.error = realError;
  }
  run.created = counter('notification_created');
  run.enqueueFailed = counter('notification_enqueue_failed');
  return run;
}

const messages = (run: Run, level: 'warn' | 'error') =>
  run.logs.filter((log) => log.level === level).map((log) => log.msg);

const cancelledByCustomer = { rideId: RIDE, cancelledBy: 'customer', toStatus: 'CANCELLED' };

after(async () => {
  await closeQueues();
});

describe('RideNotificationConsumer — S5 migration to planner → writer', () => {
  it('delegates to the shared planner and writer and keeps no notification policy of its own', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/rides/consumers/ride-notification.consumer.ts'),
      'utf8',
    );
    assert.match(source, /from '\.\/ride-notification\.planner\.js'/);
    assert.match(source, /from '\.\/ride-notification\.writer\.js'/);
    // Copy, payload, persistence and enqueue belong to the planner and writer.
    for (const forbidden of [
      'Driver assigned',
      'Ride cancelled',
      'Payment unsuccessful',
      'createNotificationWithDelivery',
      'notificationsQueue',
      'resolveOfferWindow',
      'resolveNotificationPriority',
      ':PUSH',
      '?? {}',
    ]) {
      assert.ok(!source.includes(forbidden), `consumer must not contain ${forbidden}`);
    }
  });

  it('tells a cancelled ride’s customer first, then its driver, with each write exact', async () => {
    const run = await consume('ride.cancelled', cancelledByCustomer);
    const payload = {
      v: '1',
      type: 'ride.cancelled',
      eventType: 'ride.cancelled',
      eventId: EVENT_ID,
      timestamp: OCCURRED_AT,
      category: 'TRANSACTIONAL',
      rideId: RIDE,
    };
    const input = (userId: string, body: string) => ({
      userId,
      category: 'TRANSACTIONAL',
      priority: 'HIGH',
      eventKey: 'ride.cancelled',
      idempotencyKey: `${EVENT_ID}:ride.cancelled:${userId}:PUSH`,
      title: 'Ride cancelled',
      body,
      data: payload,
      referenceType: 'RIDE',
      referenceId: RIDE,
      channel: 'PUSH',
    });
    const job = (n: number, userId: string) => ({
      name: 'notification-delivery',
      data: {
        notificationId: `notif-${n}`,
        deliveryId: `del-${n}`,
        eventId: EVENT_ID,
        eventType: 'ride.cancelled',
        userId,
        rideId: RIDE,
        category: 'TRANSACTIONAL',
      },
      opts: { jobId: `notif-${n}`, priority: 1 },
    });
    assert.deepStrictEqual(run.rows, [
      input(CUSTOMER_USER, 'Your trip has been cancelled.'),
      input(DRIVER_USER, 'The passenger cancelled this trip. You are back online.'),
    ]);
    assert.deepStrictEqual(run.enqueues, [job(1, CUSTOMER_USER), job(2, DRIVER_USER)]);
    assert.deepStrictEqual(run.logs, []);
  });

  it('plans every recipient before writing any: the one sequencing change S5 makes', async () => {
    // Before S5 the customer's insert and enqueue ran between the customer's ride
    // read and the driver's reads. The reads, the writes and their relative
    // orders are unchanged; only the interleaving moved. Pinned so any further
    // change to it is deliberate.
    const run = await consume('ride.cancelled', cancelledByCustomer);
    assert.deepStrictEqual(run.calls, [
      `ride:${RIDE}`,
      `ride:${RIDE}`,
      `driver:${DRIVER}`,
      `insert:${CUSTOMER_USER}`,
      'enqueue:notif-1',
      `insert:${DRIVER_USER}`,
      'enqueue:notif-2',
    ]);
  });

  it('isolates a failed insert to its recipient, and logs it as the consumer always has', async () => {
    for (const [failing, surviving, jobId] of [
      [CUSTOMER_USER, DRIVER_USER, 'notif-2'],
      [DRIVER_USER, CUSTOMER_USER, 'notif-1'],
    ] as const) {
      const run = await consume('ride.cancelled', cancelledByCustomer, {
        createFailsForUser: failing,
      });
      assert.deepStrictEqual(
        run.enqueues.map((e) => [e.data.userId, e.opts.jobId]),
        [[surviving, jobId]],
        `${failing} failing must not stop ${surviving}`,
      );
      assert.deepStrictEqual(messages(run, 'warn'), [
        '[rides] failed to process push notification',
      ]);
      const warned = run.logs.find((log) => log.level === 'warn');
      assert.equal(warned?.fields.userId, failing);
    }
  });

  it('keeps enqueue_failed an outcome: counted, logged as an enqueue failure, left QUEUED — never an error', async () => {
    const run = await consume('ride.cancelled', cancelledByCustomer, {
      enqueue: (call) => (call === 1 ? 'reject' : 'resolve'),
    });
    // The other recipient is unaffected.
    assert.deepStrictEqual(
      run.enqueues.map((e) => e.data.userId),
      [CUSTOMER_USER, DRIVER_USER],
    );
    assert.equal(run.created, 2);
    assert.equal(run.enqueueFailed, 1);
    // Nothing marks it failed: PA-11 finds it QUEUED and re-enqueues it.
    assert.deepStrictEqual(run.statusWrites, []);
    // Logged once, as what it is — and not also caught as a failed write.
    assert.deepStrictEqual(messages(run, 'error'), [
      '[rides] notification persisted but enqueue failed; left QUEUED for the reconciliation sweep',
    ]);
    assert.deepStrictEqual(messages(run, 'warn'), []);
  });

  it('isolates a failed lookup to its recipient, and logs it', async () => {
    const run = await consume('ride.cancelled', cancelledByCustomer, {
      rideLookupFailsOnCall: [1],
    });
    assert.deepStrictEqual(
      run.enqueues.map((e) => e.data.userId),
      [DRIVER_USER],
    );
    assert.deepStrictEqual(messages(run, 'warn'), ['[rides] failed to push-notify customer']);
  });

  it('rejects with TypeError when envelope.data is missing, before any read or write', async () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      await assert.rejects(
        consume(type, null as unknown as Record<string, unknown>),
        TypeError,
        type,
      );
    }
  });

  it('writes an offer with its exact key, job id, priority and delivery class', async () => {
    const run = await consume('ride.dispatch.offered', {
      dispatchId: 'd-1',
      requestId: 'r-1',
      driverId: DRIVER,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(run.rows.length, 1);
    assert.equal(
      run.rows[0]?.idempotencyKey,
      `${EVENT_ID}:ride.dispatch.offered:${DRIVER_USER}:PUSH`,
    );
    assert.equal(run.rows[0]?.priority, 'HIGH');
    assert.equal((run.rows[0]?.data as Record<string, string>).category, 'RIDE_OFFER');
    assert.deepStrictEqual(run.enqueues[0]?.opts, { jobId: 'notif-1', priority: 1 });
    assert.equal(run.enqueues[0]?.data.category, 'RIDE_OFFER');
  });
});
