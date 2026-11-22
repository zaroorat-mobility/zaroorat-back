import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Job, Worker } from 'bullmq';

import { container } from '../../src/core/di.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { makeAssignedVehicle, makeDriver, makeRide, makeRideRequest } from './helpers/fixtures.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { RedisService } from '../../src/core/cache/RedisService.js';
import type { EventEnvelope } from '../../src/core/events';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  maintenanceQueue,
  notificationsQueue,
} from '../../src/jobs/queues/index.js';
import { startMaintenanceWorker } from '../../src/jobs/workers/index.js';
import type { NotificationRepository } from '../../src/modules/notifications/repositories/notification.repository.js';
import type {
  NotificationDeliveryJob,
  NotificationDeliveryJobData,
} from '../../src/modules/notifications/jobs/notification-delivery.job.js';
import { NotificationReconciliationJob } from '../../src/modules/notifications/jobs/notification-reconciliation.job.js';
import type { RideRepository } from '../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../src/modules/drivers/repositories/driver.repository.js';
import { planNotifications } from '../../src/modules/rides/consumers/ride-notification.planner.js';
import {
  RECONCILED_EVENT_TYPES,
  type NotificationEventReconciliationReport,
} from '../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S10 — the reconciliation verified end to end, and the plan's remaining
/// integration items (I10, I15) and its EXPLAIN check made repeatable.
///
/// Test environment only: the mode is switched to `on` here to drive the wired
/// worker through a real recovery and a real delivery (mock push provider, as
/// every test environment uses). Nothing here changes a production default.

const NAME = JOB_NAMES.NOTIFICATION_EVENT_RECONCILIATION;
const MODE_ENV = 'NOTIFICATION_EVENT_RECONCILIATION_MODE';
const JOB_TIMEOUT_MS = 30_000;

interface World {
  customerId: string;
  driverId: string;
  rideId: string;
}

describe('F3 S10 · reconciliation end to end (PostgreSQL + Redis + BullMQ)', () => {
  let app: FastifyInstance;
  let savedMode: string | undefined;
  let worker: Worker | undefined;
  let world: World;

  const redis = (): RedisService => container.resolve<RedisService>('redisService');
  const repo = (): NotificationRepository =>
    container.resolve<NotificationRepository>('notificationRepository');
  const deliveryJob = (): NotificationDeliveryJob =>
    container.resolve<NotificationDeliveryJob>('notificationDeliveryJob');
  const notificationsMaintenance = () => maintenanceQueue(QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE);

  async function clean(): Promise<void> {
    await worker?.close();
    worker = undefined;
    await notificationsMaintenance().obliterate({ force: true });
    await notificationsQueue().obliterate({ force: true });
    await redis().provider.client.del(
      RedisKeys.notificationEventReconciliationCursor('on'),
      RedisKeys.notificationEventReconciliationCursor('dry-run'),
      RedisKeys.lock('job:notification_event_reconciliation'),
    );
  }

  before(async () => {
    app = await bootApp();
    savedMode = process.env[MODE_ENV];
  });
  after(async () => {
    if (savedMode === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = savedMode;
    await clean();
    await app.close();
  });
  beforeEach(async () => {
    await clean();
    world = await makeWorld();
  });
  afterEach(async () => {
    if (savedMode === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = savedMode;
    await clean();
    await resetState();
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

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
    const driverId = await makeDriver(await makeUser());
    const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
    const requestId = await makeRideRequest(customerId, vehicleTypeId);
    const rideId = await makeRide({ requestId, customerId, driverId, vehicleId, vehicleTypeId });
    return { customerId, driverId, rideId };
  }

  async function device(
    userId: string,
    opts: { trustState: 'TRUSTED' | 'REVOKED'; fcmToken: string | null },
  ): Promise<void> {
    await db().client.userDevice.create({
      data: {
        userId,
        deviceId: `dev-${randomUUID().slice(0, 8)}`,
        trustState: opts.trustState,
        fcmToken: opts.fcmToken,
        ...(opts.trustState === 'REVOKED' ? { revokedAt: new Date() } : {}),
      },
    });
  }

  /// A PUBLISHED ride.started — the envelope exactly as the relay emitted it.
  async function publishedStarted(): Promise<EventEnvelope> {
    const publishedAt = new Date(Date.now() - 2 * 60_000);
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      type: 'ride.started',
      version: 1,
      envelopeVersion: 1,
      occurredAt: publishedAt.toISOString(),
      producer: 'rides',
      subject: { userId: null },
      correlation: { requestId: null, sessionId: null },
      data: { rideId: world.rideId, driverId: world.driverId },
    };
    await db().client.outboxEvent.create({
      data: {
        eventId: envelope.eventId,
        aggregateType: 'ride',
        aggregateId: world.rideId,
        eventType: envelope.type,
        payload: envelope as unknown as object,
        status: 'PUBLISHED',
        publishedAt,
        createdAt: publishedAt,
      },
    });
    return envelope;
  }

  function nextResult(w: Worker, name: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const done = (job: Job, result: unknown) => {
        if (job.name !== name) return;
        cleanup();
        resolve(result);
      };
      const failed = (job: Job | undefined, err: Error) => {
        if (job?.name !== name) return;
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        w.off('completed', done);
        w.off('failed', failed);
      };
      w.on('completed', done);
      w.on('failed', failed);
    });
  }

  /// One run through the wired path: the maintenance worker, runMaintenanceJob,
  /// the DI-registered job — with the mode from the environment.
  async function runThroughWorker(mode: string): Promise<NotificationEventReconciliationReport> {
    process.env[MODE_ENV] = mode;
    worker ??= startMaintenanceWorker(QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE);
    const pending = nextResult(worker, NAME);
    await notificationsMaintenance().add(NAME, {});
    return (await pending) as NotificationEventReconciliationReport;
  }

  async function onlyNotification() {
    const rows = await db().client.notification.findMany({ include: { deliveries: true } });
    assert.equal(rows.length, 1);
    return rows[0]!;
  }

  // ── End to end ────────────────────────────────────────────────────────────

  it(
    'end to end: the wired worker recovers the notification, and the real delivery job sends it',
    { timeout: JOB_TIMEOUT_MS },
    async () => {
      await device(world.customerId, { trustState: 'TRUSTED', fcmToken: `tok-${randomUUID()}` });
      await publishedStarted();

      const report = await runThroughWorker('on');
      assert.equal(report.mode, 'on');
      assert.equal(report.recovered, 1);

      const notification = await onlyNotification();
      assert.equal(notification.userId, world.customerId);
      const job = await notificationsQueue().getJob(notification.id);
      assert.ok(job, 'enqueued under its own id');

      const delivered = await deliveryJob().run(job.data as NotificationDeliveryJobData);
      assert.equal(delivered.delivered, true);
      const after = await onlyNotification();
      assert.equal(after.status, 'SENT');
      assert.deepEqual(
        after.deliveries.map((d) => d.status),
        ['SENT'],
      );
    },
  );

  it(
    'I10 · a recipient with only revoked or token-less devices: recovered as the consumer writes it, delivery fails NO_ACTIVE_DEVICE',
    { timeout: JOB_TIMEOUT_MS },
    async () => {
      await device(world.customerId, { trustState: 'REVOKED', fcmToken: `tok-${randomUUID()}` });
      await device(world.customerId, { trustState: 'TRUSTED', fcmToken: null });
      await publishedStarted();

      const report = await runThroughWorker('on');
      assert.equal(report.recovered, 1);
      const notification = await onlyNotification();
      const job = await notificationsQueue().getJob(notification.id);
      assert.ok(job);

      const delivered = await deliveryJob().run(job.data as NotificationDeliveryJobData);
      assert.equal(delivered.delivered, false);
      assert.equal(delivered.error, 'NO_ACTIVE_DEVICE');
      const after = await onlyNotification();
      assert.equal(after.status, 'FAILED');
      assert.deepEqual(
        after.deliveries.map((d) => [d.status, d.errorCode]),
        [['FAILED', 'NO_ACTIVE_DEVICE']],
      );
    },
  );

  it(
    'I15 · a row the consumer wrote but never enqueued: reconciliation leaves it, PA-11 enqueues it',
    { timeout: JOB_TIMEOUT_MS },
    async () => {
      const envelope = await publishedStarted();
      // The consumer's insert, then a crash before its enqueue.
      const [outcome] = await planNotifications(envelope, {
        findRide: (id) => container.resolve<RideRepository>('rideRepository').findById(id),
        findDriver: (id) => container.resolve<DriverRepository>('driverRepository').findById(id),
      });
      assert.equal(outcome?.kind, 'notify');
      if (outcome?.kind !== 'notify') return;
      const { notification } = await repo().createNotificationWithDelivery(outcome.plan.input);
      await db().client.notification.update({
        where: { id: notification.id },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });

      const report = await runThroughWorker('on');
      assert.equal(report.present, 1);
      assert.equal(report.recovered, 0);
      assert.equal(await db().client.notification.count(), 1);
      assert.equal(await notificationsQueue().getJob(notification.id), undefined);

      const sweep = await new NotificationReconciliationJob(repo()).run(new Date());
      assert.equal(sweep.reenqueued, 1);
      assert.ok(await notificationsQueue().getJob(notification.id), 'PA-11 owns it');
    },
  );

  // ── EXPLAIN ───────────────────────────────────────────────────────────────

  it('EXPLAIN · the page and in-grace queries use outbox_events_status_published_at_idx, never a full scan', async () => {
    const types = [...RECONCILED_EVENT_TYPES];
    const plans = await db()
      .client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`
            INSERT INTO outbox_events (id, event_id, aggregate_type, aggregate_id, event_type, payload, status, published_at, created_at)
            SELECT gen_random_uuid(), gen_random_uuid(), 'ride', gen_random_uuid(),
                   (ARRAY['ride.started','ride.accepted','ride.dispatch.offered','ride.requested','payment.ride.collected','ride.completed'])[1 + (g % 6)],
                   '{}'::jsonb, 'PUBLISHED'::"OutboxStatus",
                   now() - (g * interval '13 seconds'), now() - (g * interval '13 seconds')
            FROM generate_series(1, 50000) g`);
          await tx.$executeRawUnsafe('ANALYZE outbox_events');
          const typeList = types.map((t) => `'${t}'`).join(',');
          const page = `
            SELECT id, event_id, event_type, payload, created_at, published_at FROM outbox_events
            WHERE status = 'PUBLISHED' AND event_type IN (${typeList})
              AND published_at >= now() - interval '1 hour' AND published_at < now() - interval '1 minute'
              AND (published_at > now() - interval '1 hour' OR id > '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY published_at, id LIMIT 200`;
          const grace = `
            SELECT count(*) FROM outbox_events
            WHERE status = 'PUBLISHED' AND event_type IN (${typeList})
              AND published_at >= now() - interval '1 minute'`;
          const explain = async (sql: string) =>
            (
              await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': unknown }>>(
                `EXPLAIN (FORMAT JSON) ${sql}`,
              )
            )[0]!['QUERY PLAN'];
          const withIndex = { page: await explain(page), grace: await explain(grace) };
          // Negative control: the same check must fail without the index.
          await tx.$executeRawUnsafe('DROP INDEX outbox_events_status_published_at_idx');
          const withoutIndex = await explain(page);
          throw Object.assign(new Error('rollback'), { plans: { withIndex, withoutIndex } });
        },
        { timeout: 120_000, maxWait: 10_000 },
      )
      .catch((err: { message: string; plans?: unknown }) => {
        if (err.message !== 'rollback') throw err;
        return err.plans as { withIndex: { page: unknown; grace: unknown }; withoutIndex: unknown };
      });

    const nodes = (plan: unknown): Array<{ type: string; index?: string; relation?: string }> => {
      const out: Array<{ type: string; index?: string; relation?: string }> = [];
      const walk = (node: Record<string, unknown>) => {
        out.push({
          type: String(node['Node Type']),
          ...(node['Index Name'] ? { index: String(node['Index Name']) } : {}),
          ...(node['Relation Name'] ? { relation: String(node['Relation Name']) } : {}),
        });
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
          walk(child);
      };
      walk((plan as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
      return out;
    };
    const usesIndex = (plan: unknown) =>
      nodes(plan).some((n) => n.index === 'outbox_events_status_published_at_idx');
    const seqScansOutbox = (plan: unknown) =>
      nodes(plan).some((n) => n.type === 'Seq Scan' && n.relation === 'outbox_events');

    assert.ok(usesIndex(plans.withIndex.page), JSON.stringify(nodes(plans.withIndex.page)));
    assert.ok(!seqScansOutbox(plans.withIndex.page));
    assert.ok(usesIndex(plans.withIndex.grace), JSON.stringify(nodes(plans.withIndex.grace)));
    assert.ok(!seqScansOutbox(plans.withIndex.grace));
    // Negative control: with the index dropped, the same detector must say so —
    // the check above cannot pass by accident.
    assert.ok(!usesIndex(plans.withoutIndex), JSON.stringify(nodes(plans.withoutIndex)));
    assert.equal(
      (
        await db().client.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'outbox_events_status_published_at_idx'`,
        )
      )[0]!.n,
      1n,
      'the index is back: everything above was rolled back',
    );
  });
});
