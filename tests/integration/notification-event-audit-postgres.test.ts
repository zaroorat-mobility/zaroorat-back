import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { notificationsQueue } from '../../src/jobs/queues/index.js';
import type { NotificationRepository } from '../../src/modules/notifications/repositories/notification.repository.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';
import type { DriverRepository } from '../../src/modules/drivers/repositories/driver.repository.js';
import type { RideRepository } from '../../src/modules/rides/repositories/ride.repository.js';
import { RideNotificationConsumer } from '../../src/modules/rides/consumers/ride-notification.consumer.js';
import { NotificationEventReconciliationJob } from '../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 go-live kit — the production-verification scripts, proven.
///
/// scripts/notification-event-audit.sql is an independent, read-only SQL audit
/// of which notifications should exist but do not. Here it must agree exactly,
/// per event type, with the reconciliation's own dry run over a scenario that
/// exercises every rule — so either can be trusted to check the other.
///
/// scripts/notification-event-fault-probe.sql is the staging fault injection.
/// Here the documented procedure runs end to end.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const script = (name: string) => readFileSync(path.join(process.cwd(), 'scripts', name), 'utf8');

/// The statement under a `-- MARKER` line of the probe script.
function probeStatement(marker: 'INJECT' | 'REMOVE'): string {
  const sql = script('notification-event-fault-probe.sql');
  const start = sql.indexOf(`-- ${marker}`);
  assert.ok(start >= 0, `probe script has a ${marker} section`);
  const body = sql.slice(start + `-- ${marker}`.length);
  const end = body.indexOf(';');
  return body.slice(0, end + 1).trim();
}

interface World {
  customerId: string;
  driverUserId: string;
  driverId: string;
  rideId: string;
  requestId: string;
}

describe('F3 go-live kit · audit SQL and fault probe (PostgreSQL + Redis)', () => {
  let app: FastifyInstance;
  let world: World;

  const redis = (): RedisService => container.resolve<RedisService>('redisService');
  const repo = (): NotificationRepository =>
    container.resolve<NotificationRepository>('notificationRepository');
  const reconciler = () =>
    container.resolve<NotificationEventReconciliationJob>('notificationEventReconciliationJob');

  async function clean(): Promise<void> {
    await db().client.$executeRawUnsafe(probeStatement('REMOVE'));
    await notificationsQueue().obliterate({ force: true });
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
    await clean();
    await app.close();
  });
  beforeEach(async () => {
    await clean();
    world = await makeWorld();
    resetMetrics();
  });
  afterEach(async () => {
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
    const driverUserId = await makeUser();
    const driverId = await makeDriver(driverUserId);
    const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
    const requestId = await makeRideRequest(customerId, vehicleTypeId);
    const rideId = await makeRide({ requestId, customerId, driverId, vehicleId, vehicleTypeId });
    return { customerId, driverUserId, driverId, rideId, requestId };
  }

  async function published(
    type: string,
    data: Record<string, unknown>,
    opts: { publishedAgoMs?: number; createdAgoMs?: number } = {},
  ): Promise<EventEnvelope> {
    const now = Date.now();
    const publishedAt = new Date(now - (opts.publishedAgoMs ?? 2 * MINUTE));
    const createdAt = new Date(
      now - (opts.createdAgoMs ?? (opts.publishedAgoMs ?? 2 * MINUTE) + 1_000),
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
        payload: envelope as unknown as object,
        status: 'PUBLISHED',
        publishedAt,
        createdAt,
      },
    });
    return envelope;
  }

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

  /// The audit, exactly as scripts/notification-event-audit.sql has it, inside a
  /// READ ONLY transaction: any write would make PostgreSQL refuse it.
  async function audit(): Promise<
    Array<{ event_type: string; audience: string; expected: number; missing: number }>
  > {
    const rows = await db().client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe<
        Array<{ event_type: string; audience: string; expected: bigint; missing: bigint }>
      >(script('notification-event-audit.sql'));
    });
    return rows.map((r) => ({ ...r, expected: Number(r.expected), missing: Number(r.missing) }));
  }

  function wouldRecoverByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of snapshotMetrics()) {
      if (s.name !== 'notification_event_reconciliation_would_recover') continue;
      out[s.labels.event_type!] = (out[s.labels.event_type!] ?? 0) + s.value;
    }
    return out;
  }

  // ── The audit agrees with the dry run ─────────────────────────────────────

  it('the audit SQL is read-only and agrees exactly, per event type, with the reconciliation’s dry run', async () => {
    const { rideId, driverId, customerId, requestId } = world;
    const ride = (extra: Record<string, unknown> = {}) => ({ rideId, driverId, ...extra });

    await published('ride.started', ride());
    await published('ride.started', ride());
    await published('ride.completed', ride({ totalFare: 150 }));
    await published('ride.cancelled', { rideId, cancelledBy: 'customer', toStatus: 'CANCELLED' });
    // The consumer told the customer, then lost the driver.
    await liveConsumer({
      async findById() {
        throw new ConnectionError('simulated lost connection');
      },
    } as unknown as DriverRepository)(
      await published('ride.cancelled', { rideId, cancelledBy: 'driver', toStatus: 'CANCELLED' }),
    );
    await liveConsumer()(await published('ride.accepted', ride())); // present
    await published('payment.ride.collection_failed', {
      rideId,
      customerId,
      amount: 150,
      willRetry: true,
    });
    await published('payment.ride.collection_failed', {
      rideId,
      customerId,
      amount: 150,
      willRetry: false,
    });
    await published('ride.request.expired', { requestId, customerId });
    await published('ride.started', ride(), { createdAgoMs: 2 * HOUR }); // past its TTL
    await published('ride.started', ride(), { publishedAgoMs: 10_000 }); // inside the grace period
    await published('ride.dispatch.offered', {
      dispatchId: randomUUID(),
      requestId,
      driverId,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    await published('ride.started', { rideId: randomUUID(), driverId }); // no such ride
    await published('ride.started', { rideId: 'not-a-uuid', driverId }); // unusable id

    const rows = await audit();
    const missing = (type: string, audience = 'customer') =>
      rows.find((r) => r.event_type === type && r.audience === audience)?.missing ?? 0;
    assert.equal(missing('ride.started'), 2);
    assert.equal(missing('ride.completed'), 1);
    assert.equal(missing('ride.cancelled', 'customer'), 1);
    assert.equal(missing('ride.cancelled', 'driver'), 2);
    assert.equal(missing('ride.accepted'), 0);
    assert.equal(
      rows.find((r) => r.event_type === 'ride.accepted')?.expected,
      1,
      'present notifications are expected, not missing',
    );
    assert.equal(missing('payment.ride.collection_failed'), 1);
    assert.equal(missing('ride.request.expired'), 1);
    const auditTotal = rows.reduce((sum, r) => sum + r.missing, 0);
    assert.equal(auditTotal, 8);

    resetMetrics();
    const report = await reconciler().run(new Date(), { mode: 'dry-run' });
    assert.equal(report.wouldRecover, auditTotal, 'the dry run and the audit agree');
    const byType = wouldRecoverByType();
    const auditByType: Record<string, number> = {};
    for (const r of rows)
      if (r.missing > 0) auditByType[r.event_type] = (auditByType[r.event_type] ?? 0) + r.missing;
    assert.deepEqual(byType, auditByType, 'and they agree per event type');
    assert.equal(await db().client.notification.count(), 2, 'neither wrote anything');
  });

  // ── The staging fault probe, end to end ───────────────────────────────────

  it('the fault probe reproduces the F3 gap, and the reconciliation closes it once the probe is removed', async () => {
    try {
      await db().client.$executeRawUnsafe(probeStatement('INJECT'));

      // A live ride.started while the probe is in: the consumer's insert fails
      // and is swallowed; the event is published with no notification.
      const envelope = await published('ride.started', {
        rideId: world.rideId,
        driverId: world.driverId,
      });
      await liveConsumer()(envelope);
      assert.equal(await db().client.notification.count(), 0);
      assert.equal(
        snapshotMetrics().find(
          (s) =>
            s.name === 'notification_live_persist_failed' && s.labels.event_type === 'ride.started',
        )?.value,
        1,
        'the live failure is counted',
      );

      const dry = await reconciler().run(new Date(), { mode: 'dry-run' });
      assert.equal(dry.wouldRecover, 1, 'the dry run sees the gap');
      assert.equal(
        (await audit()).reduce((sum, r) => sum + r.missing, 0),
        1,
        'so does the audit',
      );
    } finally {
      await db().client.$executeRawUnsafe(probeStatement('REMOVE'));
    }
    assert.equal(
      (
        await db().client.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM pg_constraint WHERE conname = 'f3_fault_probe'`,
        )
      )[0]!.n,
      0n,
      'the probe is gone',
    );

    const on = await reconciler().run(new Date(), { mode: 'on' });
    assert.equal(on.recovered, 1, 'recovered once the probe is removed');
    assert.equal(await db().client.notification.count(), 1);
    assert.equal(
      (await audit()).reduce((sum, r) => sum + r.missing, 0),
      0,
      'the audit is clean',
    );
  });
});
