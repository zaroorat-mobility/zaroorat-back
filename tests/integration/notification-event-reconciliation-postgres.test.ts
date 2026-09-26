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
import type { EventBus, EventEnvelope } from '../../src/core/events';
import type { OutboxRepository } from '../../src/core/events/OutboxRepository.js';
import { notificationsQueue } from '../../src/jobs/queues/index.js';
import type { NotificationRepository } from '../../src/modules/notifications/repositories/notification.repository.js';
import { NotificationReconciliationJob } from '../../src/modules/notifications/jobs/notification-reconciliation.job.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';
import type { DriverRepository } from '../../src/modules/drivers/repositories/driver.repository.js';
import type { RideRepository } from '../../src/modules/rides/repositories/ride.repository.js';
import { RideNotificationConsumer } from '../../src/modules/rides/consumers/ride-notification.consumer.js';
import { NotificationEventReconciliationJob } from '../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S6 — outbox notification reconciliation against real PostgreSQL, Redis and
/// BullMQ. Every event is a real PUBLISHED outbox row whose payload is the
/// envelope the relay would have handed the consumer; every recipient is a real
/// user, driver and ride. Nothing about planning, writing, the unique key or the
/// queue is stubbed except where a test injects one failure.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Data = Record<string, unknown>;

interface World {
  customerId: string;
  driverUserId: string;
  driverId: string;
  rideId: string;
  requestId: string;
}

describe('F3 · notification event reconciliation (PostgreSQL + Redis + BullMQ)', () => {
  let app: FastifyInstance;
  let world: World;
  let now: Date;

  const redis = (): RedisService => container.resolve<RedisService>('redisService');
  const repo = (): NotificationRepository =>
    container.resolve<NotificationRepository>('notificationRepository');
  const queue = () => notificationsQueue();

  const reconciler = (
    overrides: { redis?: RedisService; repository?: NotificationRepository } = {},
  ) =>
    new NotificationEventReconciliationJob(
      container.resolve<OutboxRepository>('outboxRepository'),
      overrides.repository ?? repo(),
      db(),
      overrides.redis ?? redis(),
    );

  /// The same Redis, with a lock that always grants — two of these can run at once.
  const lockless = (): RedisService =>
    ({
      lock: { acquire: async () => randomUUID(), release: async () => true },
      provider: redis().provider,
    }) as unknown as RedisService;

  async function clearRedisState(): Promise<void> {
    await redis().provider.client.del(
      RedisKeys.notificationEventReconciliationCursor('on'),
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
  });
  afterEach(async () => {
    await queue().obliterate({ force: true });
    await clearRedisState();
    await resetState();
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  async function makeUser(): Promise<string> {
    const phoneNumber = `+91${Math.floor(6_000_000_000 + Math.random() * 3_999_999_999)}`;
    const user = await db().client.user.create({
      data: { phoneNumber, status: 'ACTIVE', isPhoneVerified: true },
    });
    return user.id;
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

  /// Real producer payloads (lifecycle.service.ts, request-expiry.job.ts,
  /// collection.service.ts) for every reconciled type.
  function dataFor(type: string): Data {
    const { rideId, driverId, customerId, requestId } = world;
    switch (type) {
      case 'ride.completed':
        return { rideId, driverId, totalFare: 150 };
      case 'ride.cancelled':
        return { rideId, cancelledBy: 'customer', toStatus: 'CANCELLED' };
      case 'ride.request.expired':
        return { requestId, customerId };
      case 'payment.ride.collected':
        return { rideId, customerId, driverId, amount: 150, method: 'CASH' };
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

  function envelopeOf(type: string, data: Data, occurredAt: Date): EventEnvelope {
    return {
      eventId: randomUUID(),
      type,
      version: 1,
      envelopeVersion: 1,
      occurredAt: occurredAt.toISOString(),
      producer: type.startsWith('payment.') ? 'payments' : 'rides',
      subject: { userId: null },
      correlation: { requestId: null, sessionId: null },
      data,
    };
  }

  /// A PUBLISHED outbox row, as the relay leaves it once every subscriber ran.
  async function published(
    type: string,
    data: Data = dataFor(type),
    opts: { publishedAt?: Date; createdAt?: Date; envelope?: EventEnvelope } = {},
  ): Promise<EventEnvelope> {
    const publishedAt = opts.publishedAt ?? new Date(now.getTime() - 2 * MINUTE);
    const createdAt = opts.createdAt ?? new Date(publishedAt.getTime() - 1_000);
    const envelope = opts.envelope ?? envelopeOf(type, data, createdAt);
    await db().client.outboxEvent.create({
      data: {
        eventId: envelope.eventId,
        aggregateType: 'ride',
        aggregateId: world.rideId,
        eventType: type,
        payload: envelope as unknown as object,
        status: 'PUBLISHED',
        publishedAt,
        createdAt,
      },
    });
    return envelope;
  }

  const keyOf = (envelope: EventEnvelope, userId: string) =>
    `${envelope.eventId}:${envelope.type}:${userId}:PUSH`;

  async function notificationFor(envelope: EventEnvelope, userId: string) {
    return db().client.notification.findUnique({
      where: { idempotencyKey: keyOf(envelope, userId) },
      include: { deliveries: true },
    });
  }

  const notificationCount = () => db().client.notification.count();

  async function jobCount(): Promise<number> {
    return (
      await queue().getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed'])
    ).length;
  }

  /// The live consumer, wired to the real repositories.
  function liveConsumer(driverRepository?: DriverRepository): (e: EventEnvelope) => Promise<void> {
    const handlers = new Map<string, (e: EventEnvelope) => Promise<void>>();
    new RideNotificationConsumer(
      {
        on(type: string, handler: (e: EventEnvelope) => Promise<void>) {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
      } as unknown as EventBus,
      container.resolve<RideRepository>('rideRepository'),
      driverRepository ?? container.resolve<DriverRepository>('driverRepository'),
      container.resolve<DeviceRepository>('deviceRepository'),
      repo(),
    ).register();
    return (envelope) => handlers.get(envelope.type)!(envelope);
  }

  /// Replaces `add` on the memoised notifications queue for the duration of `work`.
  async function withAdd<T>(
    add: (...args: unknown[]) => Promise<unknown>,
    work: () => Promise<T>,
  ): Promise<T> {
    const q = queue();
    const realAdd = q.add.bind(q);
    (q as unknown as Record<string, unknown>).add = add;
    try {
      return await work();
    } finally {
      (q as unknown as Record<string, unknown>).add = realAdd;
    }
  }

  // ── Recovery and parity ───────────────────────────────────────────────────

  it('recovers every reconciled event type, writing exactly what the live consumer writes', async () => {
    const types = [
      'ride.accepted',
      'ride.driver_arriving',
      'ride.driver_arrived',
      'ride.started',
      'ride.completed',
      'ride.cancelled',
      'ride.request.expired',
      'payment.ride.collected',
      'payment.ride.collection_failed',
    ];
    const lost: EventEnvelope[] = [];
    for (const type of types) lost.push(await published(type));

    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.recovered, 10, 'nine events, ride.cancelled has two recipients');
    assert.equal(report.enqueueFailed, 0);
    assert.equal(report.caughtUp, true);

    // The same events delivered live, for comparison: same data and time, new ids.
    const deliver = liveConsumer();
    for (const envelope of lost) {
      const twin = { ...envelope, eventId: randomUUID() };
      await deliver(twin);
      const recipients =
        envelope.type === 'ride.cancelled'
          ? [world.customerId, world.driverUserId]
          : [world.customerId];
      for (const userId of recipients) {
        const recovered = await notificationFor(envelope, userId);
        const live = await notificationFor(twin, userId);
        assert.ok(recovered && live, `${envelope.type} → ${userId}`);
        const comparable = (n: NonNullable<typeof recovered>) => ({
          userId: n.userId,
          category: n.category,
          priority: n.priority,
          eventKey: n.eventKey,
          title: n.title,
          body: n.body,
          data: { ...(n.data as Data), eventId: undefined },
          status: n.status,
          referenceType: n.referenceType,
          referenceId: n.referenceId,
          deliveries: n.deliveries.map((d) => ({
            channel: d.channel,
            status: d.status,
            deviceId: d.deviceId,
            recipient: d.recipient,
          })),
        });
        assert.deepStrictEqual(comparable(recovered), comparable(live), envelope.type);

        const recoveredJob = await queue().getJob(recovered.id);
        const liveJob = await queue().getJob(live.id);
        assert.ok(recoveredJob && liveJob, `${envelope.type} jobs`);
        assert.equal(recoveredJob.opts.priority, liveJob.opts.priority);
        assert.deepStrictEqual(
          { ...recoveredJob.data, notificationId: 0, deliveryId: 0, eventId: 0 },
          { ...liveJob.data, notificationId: 0, deliveryId: 0, eventId: 0 },
        );
      }
    }
  });

  it('does not duplicate a notification the consumer already wrote', async () => {
    const envelope = await published('ride.started');
    await liveConsumer()(envelope);
    assert.equal(await notificationCount(), 1);
    const jobsBefore = await jobCount();

    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.present, 1);
    assert.equal(report.recovered, 0);
    assert.equal(await notificationCount(), 1);
    assert.equal(await jobCount(), jobsBefore);
  });

  it('recovers only the missing recipient of a cancelled ride', async () => {
    const envelope = await published('ride.cancelled');
    // The consumer told the customer, then failed to read the driver.
    const failingDrivers = {
      async findById() {
        throw new ConnectionError('simulated lost connection');
      },
    } as unknown as DriverRepository;
    await liveConsumer(failingDrivers)(envelope);
    assert.ok(await notificationFor(envelope, world.customerId));
    assert.equal(await notificationFor(envelope, world.driverUserId), null);

    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.present, 1);
    assert.equal(report.recovered, 1);
    const driver = await notificationFor(envelope, world.driverUserId);
    assert.equal(driver?.body, 'The passenger cancelled this trip. You are back online.');
  });

  // ── Grace, TTL, offers, skips ─────────────────────────────────────────────

  it('leaves an event inside the grace period for a later run', async () => {
    const envelope = await published('ride.started', undefined, {
      publishedAt: new Date(now.getTime() - 30_000),
    });
    const early = await reconciler().run(now, { mode: 'on' });
    assert.equal(early.scanned, 0);
    assert.equal(await notificationFor(envelope, world.customerId), null);

    const later = await reconciler().run(new Date(now.getTime() + MINUTE), { mode: 'on' });
    assert.equal(later.recovered, 1);
    assert.ok(await notificationFor(envelope, world.customerId));
  });

  it('does not resurrect an event past its TTL: expired at exactly one hour, recovered a second earlier', async () => {
    const stale = await published('ride.started', undefined, {
      createdAt: new Date(now.getTime() - HOUR),
      publishedAt: new Date(now.getTime() - 2 * MINUTE),
    });
    const fresh = await published('ride.started', undefined, {
      createdAt: new Date(now.getTime() - HOUR + 1_000),
      publishedAt: new Date(now.getTime() - 2 * MINUTE),
    });
    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.expired, 1);
    assert.equal(report.recovered, 1);
    assert.equal(await notificationFor(stale, world.customerId), null);
    assert.ok(await notificationFor(fresh, world.customerId));
  });

  it('never scans ride offers', async () => {
    await published('ride.dispatch.offered', {
      dispatchId: randomUUID(),
      requestId: world.requestId,
      driverId: world.driverId,
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
    });
    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.scanned, 0);
    assert.equal(await notificationCount(), 0);
  });

  it('skips exactly what the consumer skips, and moves past it', async () => {
    await published('payment.ride.collection_failed', {
      ...dataFor('payment.ride.collection_failed'),
      willRetry: true,
    });
    await published('ride.started', { rideId: randomUUID(), driverId: world.driverId });
    await published('ride.request.expired', { requestId: world.requestId });

    const first = await reconciler().run(now, { mode: 'on' });
    assert.equal(first.scanned, 3);
    assert.equal(first.skipped, 3);
    assert.equal(await notificationCount(), 0);

    const second = await reconciler().run(now, { mode: 'on' });
    assert.equal(second.scanned, 0, 'the cursor moved past skipped events');
  });

  it('writes for an erased user exactly as the consumer would: user state is not consulted', async () => {
    await db().client.user.update({
      where: { id: world.customerId },
      data: { deletedAt: now, phoneNumber: `erased:${world.customerId}` },
    });
    const envelope = await published('ride.started');
    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.recovered, 1);
    assert.ok(await notificationFor(envelope, world.customerId));
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  it('concurrent runs: the lock admits exactly one', async () => {
    await published('ride.started');
    const [a, b] = await Promise.all([
      reconciler().run(now, { mode: 'on' }),
      reconciler().run(now, { mode: 'on' }),
    ]);
    const ran = [a, b].filter((r) => r.ran);
    assert.equal(ran.length, 1);
    assert.equal([a, b].find((r) => !r.ran)?.aborted, 'lock_held');
    assert.equal(await notificationCount(), 1);
  });

  it('concurrent runs without the lock: the idempotency key still admits one row and one job each', async () => {
    const events: EventEnvelope[] = [];
    for (let i = 0; i < 20; i += 1) events.push(await published('ride.started'));

    const [a, b] = await Promise.all([
      reconciler({ redis: lockless() }).run(now, { mode: 'on' }),
      reconciler({ redis: lockless() }).run(now, { mode: 'on' }),
    ]);
    assert.equal(await notificationCount(), 20);
    assert.equal(await jobCount(), 20);
    assert.equal(a.recovered + b.recovered, 20, 'each notification written once');
    assert.equal(a.recovered + a.duplicate + a.present, 20);
    assert.equal(b.recovered + b.duplicate + b.present, 20);
  });

  it('the consumer and reconciliation racing on one event write one notification and one job', async () => {
    const envelope = await published('ride.started');
    await Promise.all([liveConsumer()(envelope), reconciler().run(now, { mode: 'on' })]);
    assert.equal(await notificationCount(), 1);
    assert.equal(await jobCount(), 1);
  });

  // ── Failure isolation ─────────────────────────────────────────────────────

  it('one event’s permanent failure does not stop the batch, and is not retried', async () => {
    const before = await published('ride.started');
    // A recipient that is not a user: the insert fails its foreign key.
    await published('ride.request.expired', {
      requestId: world.requestId,
      customerId: randomUUID(),
    });
    const behind = await published('ride.completed');

    const report = await reconciler().run(now, { mode: 'on' });
    assert.equal(report.permanentFailures, 1);
    assert.equal(report.recovered, 2);
    assert.equal(report.caughtUp, true);
    assert.ok(await notificationFor(before, world.customerId));
    assert.ok(await notificationFor(behind, world.customerId));

    const rerun = await reconciler().run(now, { mode: 'on' });
    assert.equal(rerun.scanned, 0, 'a permanent failure is recorded and moved past');
  });

  it('a transient failure ends the run at that event; the next run resumes there', async () => {
    const events = [
      await published('ride.started', undefined, {
        publishedAt: new Date(now.getTime() - 3 * MINUTE),
      }),
      await published('ride.completed', undefined, {
        publishedAt: new Date(now.getTime() - 2.5 * MINUTE),
      }),
      await published('ride.accepted', undefined, {
        publishedAt: new Date(now.getTime() - 2 * MINUTE),
      }),
    ];
    const flaky = Object.create(repo()) as NotificationRepository;
    flaky.createNotificationWithDelivery = async (input) => {
      if (input.eventKey === 'ride.completed')
        throw new ConnectionError('simulated lost connection');
      return repo().createNotificationWithDelivery(input);
    };

    const first = await reconciler({ repository: flaky }).run(now, { mode: 'on' });
    assert.equal(first.aborted, 'transient_db');
    assert.equal(first.transientFailures, 1);
    assert.equal(first.recovered, 1);
    assert.equal(await notificationFor(events[2]!, world.customerId), null, 'not reached');

    const second = await reconciler().run(now, { mode: 'on' });
    assert.equal(second.scanned, 2, 'resumes at the event that failed');
    assert.equal(second.recovered, 2);
    for (const envelope of events) assert.ok(await notificationFor(envelope, world.customerId));
  });

  // ── Cursor, paging, idempotent reruns ─────────────────────────────────────

  it('pages through events that share one publishedAt without skipping or repeating any', async () => {
    const publishedAt = new Date(now.getTime() - 2 * MINUTE);
    for (let i = 0; i < 250; i += 1) await published('ride.started', undefined, { publishedAt });

    const report = await reconciler().run(now, { mode: 'on', pageSize: 100 });
    assert.equal(report.scanned, 250);
    assert.equal(report.recovered, 250);
    assert.equal(report.caughtUp, true);
    assert.equal(await notificationCount(), 250);

    const rerun = await reconciler().run(now, { mode: 'on', pageSize: 100 });
    assert.equal(rerun.scanned, 0);
  });

  it('stops at the run budget and continues from its cursor next time', async () => {
    for (let i = 0; i < 5; i += 1) await published('ride.started');
    const first = await reconciler().run(now, { mode: 'on', pageSize: 2, runBudgetMs: 0 });
    assert.equal(first.aborted, 'budget');
    assert.equal(first.scanned, 2);
    const second = await reconciler().run(now, { mode: 'on', pageSize: 100 });
    assert.equal(second.scanned, 3);
    assert.equal(await notificationCount(), 5);
  });

  it('rerunning is idempotent, even after the cursor is lost', async () => {
    for (let i = 0; i < 3; i += 1) await published('ride.started');
    await reconciler().run(now, { mode: 'on' });
    const jobs = await jobCount();

    const rerun = await reconciler().run(now, { mode: 'on' });
    assert.equal(rerun.scanned, 0);

    await redis().provider.client.del(RedisKeys.notificationEventReconciliationCursor('on'));
    const fromScratch = await reconciler().run(now, { mode: 'on' });
    assert.equal(fromScratch.scanned, 3);
    assert.equal(fromScratch.present, 3);
    assert.equal(fromScratch.recovered, 0);
    assert.equal(await notificationCount(), 3);
    assert.equal(await jobCount(), jobs);
  });

  // ── Enqueue failures belong to PA-11 ──────────────────────────────────────

  it('an enqueue failure leaves the row QUEUED; PA-11 then enqueues it under its own id', async () => {
    const envelope = await published('ride.started');
    const report = await withAdd(
      async () => {
        throw new Error('simulated enqueue failure');
      },
      () => reconciler().run(now, { mode: 'on' }),
    );
    assert.equal(report.recovered, 1);
    assert.equal(report.enqueueFailed, 1);
    const row = await notificationFor(envelope, world.customerId);
    assert.equal(row?.status, 'QUEUED');
    assert.equal(await queue().getJob(row!.id), undefined);

    const sweep = await new NotificationReconciliationJob(repo()).run(
      new Date(Date.now() + MINUTE),
    );
    assert.equal(sweep.reenqueued, 1);
    assert.ok(await queue().getJob(row!.id), 'PA-11 re-enqueued it under notification.id');
  });

  it('an unreachable queue ends the run; the next run finds the row and leaves it to PA-11', async () => {
    const envelope = await published('ride.started');
    const report = await withAdd(
      () => new Promise(() => {}),
      () => reconciler().run(now, { mode: 'on' }),
    );
    assert.equal(report.aborted, 'queue_unavailable');
    assert.equal(report.recovered, 1);
    assert.ok(await notificationFor(envelope, world.customerId));

    const next = await reconciler().run(now, { mode: 'on' });
    assert.equal(next.present, 1);
    assert.equal(next.recovered, 0);
    assert.equal(await notificationCount(), 1);
  });

  // ── Modes and scope ───────────────────────────────────────────────────────

  it('dry-run counts what it would write, writes nothing, and leaves the real cursor alone', async () => {
    for (let i = 0; i < 3; i += 1) await published('ride.started');
    const dry = await reconciler().run(now, { mode: 'dry-run' });
    assert.equal(dry.wouldRecover, 3);
    assert.equal(await notificationCount(), 0);
    assert.equal(
      await redis().provider.client.get(RedisKeys.notificationEventReconciliationCursor('on')),
      null,
    );

    const real = await reconciler().run(now, { mode: 'on' });
    assert.equal(real.recovered, 3);
  });

  it('off does nothing', async () => {
    await published('ride.started');
    const report = await reconciler().run(now, { mode: 'off' });
    assert.equal(report.ran, false);
    assert.equal(report.scanned, 0);
    assert.equal(await notificationCount(), 0);
  });

  it('replays no other subscriber: reconciling ride.completed publishes and collects nothing', async () => {
    await published('ride.completed');
    const outboxBefore = await db().client.outboxEvent.count();
    const paymentsBefore = await db().client.ridePayment.count();

    await reconciler().run(now, { mode: 'on' });
    assert.equal(await db().client.outboxEvent.count(), outboxBefore);
    assert.equal(await db().client.ridePayment.count(), paymentsBefore);
    assert.equal(await notificationCount(), 1);
  });
});
