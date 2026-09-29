import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../src/core/di.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { makeAssignedVehicle, makeDriver, makeRide, makeRideRequest } from './helpers/fixtures.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { RedisService } from '../../src/core/cache/RedisService.js';
import { ConnectionError } from '../../src/core/database/errors/DatabaseError.js';
import { resetMetrics, snapshotMetrics } from '../../src/core/metrics/index.js';
import type { EventBus, EventEnvelope } from '../../src/core/events';
import type { OutboxRepository } from '../../src/core/events/OutboxRepository.js';
import { notificationsQueue } from '../../src/jobs/queues/index.js';
import type { NotificationRepository } from '../../src/modules/notifications/repositories/notification.repository.js';
import { NotificationReconciliationJob } from '../../src/modules/notifications/jobs/notification-reconciliation.job.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';
import type { DriverRepository } from '../../src/modules/drivers/repositories/driver.repository.js';
import type { RideRepository } from '../../src/modules/rides/repositories/ride.repository.js';
import { RideNotificationConsumer } from '../../src/modules/rides/consumers/ride-notification.consumer.js';
import {
  NotificationEventReconciliationJob,
  RECONCILED_EVENT_TYPES,
  type ReconciliationMetrics,
} from '../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S7 — the reconciliation job's metrics, from real runs against PostgreSQL,
/// Redis and BullMQ. Every assertion reads the process's metrics registry after
/// one run, so each counter is proven by the run that should move it.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PREFIX = 'notification_event_reconciliation_';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Data = Record<string, unknown>;

/// Every value a reconciliation label can take. Anything else — above all an
/// id — fails the boundedness test.
const ALLOWED_LABEL_VALUES: Record<string, readonly string[]> = {
  event_type: RECONCILED_EVENT_TYPES,
  category: ['CRITICAL', 'RIDE_OFFER', 'TRANSACTIONAL', 'GENERAL', 'PROMOTIONAL'],
  scope: ['on', 'dry-run', 'off'],
  result: [
    'transient',
    'permanent',
    'off',
    'lock_held',
    'caught_up',
    'budget',
    'transient_db',
    'queue_unavailable',
    'error',
  ],
  reason: [
    // planner skips
    'missing_ride_id',
    'missing_driver_id',
    'missing_customer_id',
    'will_retry',
    'ride_not_found',
    'ride_has_no_driver',
    'driver_not_found',
    // expiry
    'offer_expired',
    'ttl_elapsed',
    // failures
    'connection',
    'write_conflict',
    'transient',
    'value_too_long',
    'unique_violation',
    'foreign_key',
    'constraint',
    'invalid_data',
    'validation',
    'database',
    'programming',
    'invalid_envelope',
    'lookup_failed',
    // cursor
    'missing',
    'behind_lookback',
  ],
};

interface World {
  customerId: string;
  driverUserId: string;
  driverId: string;
  rideId: string;
  requestId: string;
}

describe('F3 · reconciliation metrics (PostgreSQL + Redis + BullMQ)', () => {
  let app: FastifyInstance;
  let world: World;
  let now: Date;

  const redis = (): RedisService => container.resolve<RedisService>('redisService');
  const repo = (): NotificationRepository =>
    container.resolve<NotificationRepository>('notificationRepository');
  const queue = () => notificationsQueue();
  const reconciler = (repository: NotificationRepository = repo()) =>
    new NotificationEventReconciliationJob(
      container.resolve<OutboxRepository>('outboxRepository'),
      repository,
      db(),
      redis(),
    );
  const cursorKey = RedisKeys.notificationEventReconciliationCursor('on');

  async function clearRedisState(): Promise<void> {
    await redis().provider.client.del(
      cursorKey,
      RedisKeys.notificationEventReconciliationCursor('dry-run'),
      RedisKeys.lock('job:notification_event_reconciliation'),
    );
  }

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await queue().obliterate({ force: true });
    await clearRedisState();
    await app.close();
  });
  beforeEach(async () => {
    await queue().obliterate({ force: true });
    await clearRedisState();
    now = new Date();
    world = await makeWorld();
    resetMetrics();
  });
  afterEach(async () => {
    await queue().obliterate({ force: true });
    await clearRedisState();
    await resetState();
  });

  // ── Fixtures (as in the S6 suite) ─────────────────────────────────────────

  async function makeUser(): Promise<string> {
    const phoneNumber = `+91${Math.floor(6_000_000_000 + Math.random() * 3_999_999_999)}`;
    return (
      await db().client.user.create({
        data: { phoneNumber, status: 'ACTIVE', isPhoneVerified: true },
      })
    ).id;
  }

  async function makeWorld(): Promise<World> {
    const customerId = await makeUser();
    const driverUserId = await makeUser();
    const driverId = await makeDriver(driverUserId);
    const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
    const requestId = await makeRideRequest(customerId, vehicleTypeId);
    const rideId = await makeRide({ requestId, customerId, driverId, vehicleId, vehicleTypeId });
    return { customerId, driverUserId, driverId, rideId, requestId };
  }

  function dataFor(type: string): Data {
    const { rideId, driverId, customerId, requestId } = world;
    switch (type) {
      case 'ride.cancelled':
        return { rideId, cancelledBy: 'customer', toStatus: 'CANCELLED' };
      case 'ride.request.expired':
        return { requestId, customerId };
      case 'payment.ride.collection_failed':
        return {
          rideId,
          customerId,
          amount: 150,
          attempt: 3,
          willRetry: false,
          reason: 'declined',
        };
      default:
        return { rideId, driverId };
    }
  }

  async function published(
    type: string,
    data: Data = dataFor(type),
    opts: { publishedAgoMs?: number; createdAgoMs?: number; payload?: unknown } = {},
  ): Promise<EventEnvelope> {
    const publishedAt = new Date(now.getTime() - (opts.publishedAgoMs ?? 2 * MINUTE));
    const createdAt = new Date(
      now.getTime() - (opts.createdAgoMs ?? (opts.publishedAgoMs ?? 2 * MINUTE) + 1_000),
    );
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      type,
      version: 1,
      envelopeVersion: 1,
      occurredAt: createdAt.toISOString(),
      producer: type.startsWith('payment.') ? 'payments' : 'rides',
      subject: { userId: null },
      correlation: { requestId: null, sessionId: null },
      data,
    };
    await db().client.outboxEvent.create({
      data: {
        eventId: envelope.eventId,
        aggregateType: 'ride',
        aggregateId: world.rideId,
        eventType: type,
        payload: (opts.payload ?? envelope) as object,
        status: 'PUBLISHED',
        publishedAt,
        createdAt,
      },
    });
    return envelope;
  }

  /// The sample with exactly these labels, in any order.
  function metric(name: string, labels: Record<string, string> = {}): number | undefined {
    const want = Object.entries(labels).sort().join('|');
    return snapshotMetrics().find(
      (s) => s.name === `${PREFIX}${name}` && Object.entries(s.labels).sort().join('|') === want,
    )?.value;
  }
  const count = (name: string, labels: Record<string, string> = {}) => metric(name, labels) ?? 0;

  async function withAdd<T>(add: () => Promise<unknown>, work: () => Promise<T>): Promise<T> {
    const q = queue();
    const realAdd = q.add.bind(q);
    (q as unknown as Record<string, unknown>).add = add;
    try {
      return await work();
    } finally {
      (q as unknown as Record<string, unknown>).add = realAdd;
    }
  }

  async function liveDeliver(envelope: EventEnvelope): Promise<void> {
    const handlers = new Map<string, (e: EventEnvelope) => Promise<void>>();
    new RideNotificationConsumer(
      {
        on(type: string, handler: (e: EventEnvelope) => Promise<void>) {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
      } as unknown as EventBus,
      container.resolve<RideRepository>('rideRepository'),
      container.resolve<DriverRepository>('driverRepository'),
      container.resolve<DeviceRepository>('deviceRepository'),
      repo(),
    ).register();
    await handlers.get(envelope.type)!(envelope);
  }

  // ── Outcomes, by event type and reason ────────────────────────────────────

  it('counts every outcome of a run, labelled by event type and reason', async () => {
    await published('ride.started');
    await published('ride.started');
    await published('ride.cancelled'); // two recipients
    await liveDeliver(await published('ride.accepted')); // already present
    await published('payment.ride.collection_failed', {
      ...dataFor('payment.ride.collection_failed'),
      willRetry: true,
    });
    await published('ride.completed', undefined, { createdAgoMs: HOUR + MINUTE });
    await published('ride.driver_arrived', undefined, { payload: { type: 'mismatched' } });
    resetMetrics();

    const report = await reconciler().run(now, { mode: 'on' });

    assert.equal(count('scanned', { event_type: 'ride.started' }), 2);
    assert.equal(count('scanned', { event_type: 'ride.cancelled' }), 1);
    assert.equal(count('scanned', { event_type: 'ride.accepted' }), 1);
    assert.equal(count('eligible', { event_type: 'ride.started' }), 2);
    assert.equal(count('expired', { event_type: 'ride.completed', reason: 'ttl_elapsed' }), 1);
    assert.equal(
      count('skipped', { event_type: 'payment.ride.collection_failed', reason: 'will_retry' }),
      1,
    );
    assert.equal(count('present', { event_type: 'ride.accepted' }), 1);
    assert.equal(count('recovered', { event_type: 'ride.started', category: 'TRANSACTIONAL' }), 2);
    assert.equal(
      count('recovered', { event_type: 'ride.cancelled', category: 'TRANSACTIONAL' }),
      2,
    );
    assert.equal(
      count('failed', {
        event_type: 'ride.driver_arrived',
        result: 'permanent',
        reason: 'invalid_envelope',
      }),
      1,
    );
    assert.equal(count('runs', { result: 'caught_up', scope: 'on' }), 1);
    assert.equal(count('pages', { scope: 'on' }), 1);
    assert.ok(count('page_duration_ms_total', { scope: 'on' }) >= 0);
    assert.equal(count('run_duration_ms_total', { scope: 'on' }), report.durationMs);
    assert.equal(metric('last_run_duration_ms'), report.durationMs);
    assert.equal(metric('lag_seconds'), 0, 'caught up');

    // The counters agree with the run report.
    const total = (name: string) =>
      snapshotMetrics()
        .filter((s) => s.name === `${PREFIX}${name}`)
        .reduce((sum, s) => sum + s.value, 0);
    assert.equal(total('scanned'), report.scanned);
    assert.equal(total('eligible'), report.eligible);
    assert.equal(total('expired'), report.expired);
    assert.equal(total('skipped'), report.skipped);
    assert.equal(total('present'), report.present);
    assert.equal(total('recovered'), report.recovered);
    assert.equal(total('failed'), report.permanentFailures + report.transientFailures);
  });

  it('measures how old recovered events were, from creation — the sum and the oldest', async () => {
    await published('ride.started', undefined, {
      publishedAgoMs: 2 * MINUTE,
      createdAgoMs: 10 * MINUTE,
    });
    await published('ride.started', undefined, {
      publishedAgoMs: 2 * MINUTE,
      createdAgoMs: 4 * MINUTE,
    });
    await reconciler().run(now, { mode: 'on' });
    assert.equal(count('recovered_age_seconds_total', { event_type: 'ride.started' }), 600 + 240);
    assert.equal(metric('recovered_age_seconds_max'), 600);
  });

  // ── Runs that do little or nothing ────────────────────────────────────────

  it('counts a run that finds the lock held, and nothing else', async () => {
    await published('ride.started');
    const token = await redis().lock.acquire('job:notification_event_reconciliation', MINUTE);
    try {
      await reconciler().run(now, { mode: 'on' });
    } finally {
      await redis().lock.release('job:notification_event_reconciliation', token!);
    }
    assert.deepEqual(
      snapshotMetrics().filter((s) => s.name.startsWith(PREFIX)),
      [
        {
          name: `${PREFIX}runs`,
          type: 'counter',
          labels: { result: 'lock_held', scope: 'on' },
          value: 1,
        },
      ],
    );
  });

  it('counts a run while off, and nothing else', async () => {
    await reconciler().run(now, { mode: 'off' });
    assert.equal(count('runs', { result: 'off', scope: 'off' }), 1);
    assert.equal(snapshotMetrics().filter((s) => s.name.startsWith(PREFIX)).length, 1);
  });

  it('dry-run counts what it would write, under its own scope', async () => {
    await published('ride.started');
    await reconciler().run(now, { mode: 'dry-run' });
    assert.equal(count('would_recover', { event_type: 'ride.started' }), 1);
    assert.equal(count('recovered', { event_type: 'ride.started', category: 'TRANSACTIONAL' }), 0);
    assert.equal(count('runs', { result: 'caught_up', scope: 'dry-run' }), 1);
  });

  // ── Failures, lag, and what PA-11 owns ────────────────────────────────────

  it('a transient failure: counted by reason, the run ends transient_db, lag is the stuck event’s age', async () => {
    await published('ride.started', undefined, { publishedAgoMs: 3 * MINUTE });
    await published('ride.completed', undefined, { publishedAgoMs: 150_000 });
    const flaky = Object.create(repo()) as NotificationRepository;
    flaky.createNotificationWithDelivery = async (input) => {
      if (input.eventKey === 'ride.completed')
        throw new ConnectionError('simulated lost connection');
      return repo().createNotificationWithDelivery(input);
    };
    const report = await reconciler(flaky).run(now, { mode: 'on' });
    assert.equal(
      count('failed', { event_type: 'ride.completed', result: 'transient', reason: 'connection' }),
      1,
    );
    assert.equal(count('runs', { result: 'transient_db', scope: 'on' }), 1);
    assert.equal(report.lagSeconds, 150);
    assert.equal(metric('lag_seconds'), 150);
  });

  it('a permanent failure is counted by its fixed reason', async () => {
    await published('ride.request.expired', {
      requestId: world.requestId,
      customerId: randomUUID(),
    });
    await reconciler().run(now, { mode: 'on' });
    assert.equal(
      count('failed', {
        event_type: 'ride.request.expired',
        result: 'permanent',
        reason: 'foreign_key',
      }),
      1,
    );
  });

  it('an unreachable queue: the run ends queue_unavailable and the enqueue failure is counted', async () => {
    await published('ride.started');
    await withAdd(
      () => new Promise(() => {}),
      () => reconciler().run(now, { mode: 'on' }),
    );
    assert.equal(count('runs', { result: 'queue_unavailable', scope: 'on' }), 1);
    assert.equal(
      count('enqueue_failed', { event_type: 'ride.started', category: 'TRANSACTIONAL' }),
      1,
    );
  });

  it('tells S6 recoveries from PA-11 re-enqueues', async () => {
    await published('ride.started');
    await withAdd(
      async () => {
        throw new Error('simulated enqueue failure');
      },
      () => reconciler().run(now, { mode: 'on' }),
    );
    await new NotificationReconciliationJob(repo()).run(new Date(Date.now() + MINUTE));
    assert.equal(count('recovered', { event_type: 'ride.started', category: 'TRANSACTIONAL' }), 1);
    assert.equal(
      count('enqueue_failed', { event_type: 'ride.started', category: 'TRANSACTIONAL' }),
      1,
    );
    const pa11 = snapshotMetrics()
      .filter((s) => s.name === 'notification_reconciliation_reenqueued')
      .reduce((sum, s) => sum + s.value, 0);
    assert.equal(pa11, 1, 'PA-11 re-enqueued what S6 wrote, under its own metric');
  });

  it('a run cut short by its budget reports the lag the cursor leaves behind', async () => {
    for (const ago of [5, 4, 3, 2])
      await published('ride.started', undefined, { publishedAgoMs: ago * MINUTE });
    const report = await reconciler().run(now, { mode: 'on', pageSize: 2, runBudgetMs: 0 });
    assert.equal(count('runs', { result: 'budget', scope: 'on' }), 1);
    assert.equal(report.lagSeconds, 240, 'the cursor stopped at the event published 4 minutes ago');
    assert.equal(metric('lag_seconds'), 240);
  });

  // ── Window: grace, cursor, lookback ───────────────────────────────────────

  it('counts events still inside the grace period', async () => {
    await published('ride.started');
    await published('ride.started', undefined, { publishedAgoMs: 30_000 });
    await published('ride.started', undefined, { publishedAgoMs: 10_000 });
    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.scanned, 1);
    assert.equal(metric('in_grace'), 2);
  });

  it('counts a missing cursor, and the events passed over when the cursor fell behind the lookback', async () => {
    await reconciler().run(now, { mode: 'on' });
    assert.equal(count('cursor_reset', { reason: 'missing' }), 1);

    resetMetrics();
    await redis().provider.client.set(
      cursorKey,
      JSON.stringify({
        publishedAt: new Date(now.getTime() - 2 * HOUR).toISOString(),
        id: '00000000-0000-0000-0000-000000000000',
      }),
    );
    await published('ride.started', undefined, { publishedAgoMs: 90 * MINUTE });
    await published('ride.started', undefined, { publishedAgoMs: 80 * MINUTE });
    await published('ride.started');
    await reconciler().run(now, { mode: 'on' });
    assert.equal(count('cursor_reset', { reason: 'behind_lookback' }), 1);
    assert.equal(count('window_skipped'), 2);
    assert.equal(count('recovered', { event_type: 'ride.started', category: 'TRANSACTIONAL' }), 1);
  });

  // ── Metrics must never cost progress ──────────────────────────────────────

  it('an emitter that throws on every call changes nothing about the run', async () => {
    const events = [await published('ride.started'), await published('ride.cancelled')];
    const broken: ReconciliationMetrics = {
      count: () => {
        throw new Error('metrics sink down');
      },
      gauge: () => {
        throw new Error('metrics sink down');
      },
    };
    const report = await reconciler().run(now, { mode: 'on', metrics: broken });
    assert.equal(report.recovered, 3);
    assert.equal(report.caughtUp, true);
    assert.equal(await db().client.notification.count(), 3);
    for (const envelope of events) {
      assert.ok(
        await db().client.notification.findFirst({ where: { eventKey: envelope.type } }),
        envelope.type,
      );
    }
    const rerun = await reconciler().run(now, { mode: 'on', metrics: broken });
    assert.equal(rerun.scanned, 0, 'the cursor was saved despite the broken emitter');
  });

  // ── Cardinality ───────────────────────────────────────────────────────────

  it('labels are bounded: fixed keys, fixed values, never an id', async () => {
    await published('ride.started');
    await published('ride.cancelled');
    await published('ride.request.expired', {
      requestId: world.requestId,
      customerId: randomUUID(),
    });
    await published('payment.ride.collection_failed', {
      ...dataFor('payment.ride.collection_failed'),
      willRetry: true,
    });
    await published('ride.started', { rideId: randomUUID(), driverId: world.driverId });
    await published('ride.completed', undefined, { createdAgoMs: 2 * HOUR });
    await reconciler().run(now, { mode: 'on' });

    const samples = snapshotMetrics().filter((s) => s.name.startsWith(PREFIX));
    assert.ok(samples.length > 10, 'the run emitted a representative set');
    const ids = [
      world.customerId,
      world.driverUserId,
      world.driverId,
      world.rideId,
      world.requestId,
    ];
    for (const sample of samples) {
      for (const [key, label] of Object.entries(sample.labels)) {
        const allowed = ALLOWED_LABEL_VALUES[key];
        assert.ok(allowed, `${sample.name}: unexpected label ${key}`);
        assert.ok(allowed.includes(label), `${sample.name}: ${key}=${label}`);
        assert.doesNotMatch(label, UUID, `${sample.name}.${key}`);
        assert.ok(!ids.some((id) => label.includes(id)), `${sample.name}.${key} carries an id`);
      }
    }
  });
});
