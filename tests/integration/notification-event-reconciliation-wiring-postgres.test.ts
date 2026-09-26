import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';

import { container } from '../../src/core/di.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { makeAssignedVehicle, makeDriver, makeRide, makeRideRequest } from './helpers/fixtures.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { RedisService } from '../../src/core/cache/RedisService.js';
import {
  QUEUE_NAMES,
  createQueueConnection,
  maintenanceQueue,
  notificationsQueue,
} from '../../src/jobs/queues/index.js';
import {
  JOB_SCHEDULES,
  SCHEDULE_TIMEZONE,
  registerJobSchedules,
} from '../../src/jobs/scheduler/index.js';
import { NotificationEventReconciliationJob } from '../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S8 — the pre-wiring contract against real PostgreSQL, Redis and BullMQ.
///
/// Proves what S9 will rely on: the call the maintenance worker makes —
/// `run(now)`, mode from the environment — is a dry run when the mode is unset
/// and inert when off; registering the schedules installs the reconciliation
/// and PA-11 exactly once each (flipped in S9, which wired it); and a BullMQ job
/// scheduler outlives the code that registered it, so undoing S9 needs an
/// explicit `removeJobScheduler`.

const MODE_ENV = 'NOTIFICATION_EVENT_RECONCILIATION_MODE';
const LOCK_KEY = RedisKeys.lock('job:notification_event_reconciliation');

describe('F3 S8 · reconciliation wiring contract (PostgreSQL + Redis + BullMQ)', () => {
  let app: FastifyInstance;
  let savedMode: string | undefined;
  let now: Date;

  const redis = (): RedisService => container.resolve<RedisService>('redisService');
  const job = () => container.build(NotificationEventReconciliationJob);

  async function clearRedisState(): Promise<void> {
    await redis().provider.client.del(
      RedisKeys.notificationEventReconciliationCursor('on'),
      RedisKeys.notificationEventReconciliationCursor('dry-run'),
      LOCK_KEY,
    );
  }

  before(async () => {
    app = await bootApp();
    savedMode = process.env[MODE_ENV];
  });
  after(async () => {
    if (savedMode === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = savedMode;
    await notificationsQueue().obliterate({ force: true });
    await clearRedisState();
    await app.close();
  });
  beforeEach(async () => {
    await notificationsQueue().obliterate({ force: true });
    await clearRedisState();
    now = new Date();
  });
  afterEach(async () => {
    await notificationsQueue().obliterate({ force: true });
    await clearRedisState();
    await resetState();
  });

  /// One PUBLISHED ride.started with no notification: something to recover.
  async function strandedEvent(): Promise<void> {
    const user = async () =>
      (
        await db().client.user.create({
          data: {
            phoneNumber: `+91${Math.floor(6_000_000_000 + Math.random() * 3_999_999_999)}`,
            status: 'ACTIVE',
            isPhoneVerified: true,
          },
        })
      ).id;
    const customerId = await user();
    const driverId = await makeDriver(await user());
    const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
    const requestId = await makeRideRequest(customerId, vehicleTypeId);
    const rideId = await makeRide({ requestId, customerId, driverId, vehicleId, vehicleTypeId });
    const publishedAt = new Date(now.getTime() - 2 * 60_000);
    const eventId = randomUUID();
    await db().client.outboxEvent.create({
      data: {
        eventId,
        aggregateType: 'ride',
        aggregateId: rideId,
        eventType: 'ride.started',
        status: 'PUBLISHED',
        publishedAt,
        createdAt: publishedAt,
        payload: {
          eventId,
          type: 'ride.started',
          version: 1,
          envelopeVersion: 1,
          occurredAt: publishedAt.toISOString(),
          producer: 'rides',
          subject: { userId: null },
          correlation: { requestId: null, sessionId: null },
          data: { rideId, driverId },
        },
      },
    });
  }

  it('with the mode unset, the worker’s call — run(now) — is a dry run: it counts and writes nothing', async () => {
    await strandedEvent();
    delete process.env[MODE_ENV];

    const report = await job().run(now);

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.wouldRecover, 1);
    assert.equal(report.recovered, 0);
    assert.equal(await db().client.notification.count(), 0);
    assert.equal(
      (await notificationsQueue().getJobs(['waiting', 'prioritized', 'delayed'])).length,
      0,
    );
    assert.equal(
      await redis().provider.client.get(RedisKeys.notificationEventReconciliationCursor('on')),
      null,
      'a dry run never moves the real cursor',
    );
  });

  it('off: the worker’s call takes no lock, reads nothing and writes nothing', async () => {
    await strandedEvent();
    process.env[MODE_ENV] = 'off';

    const report = await job().run(now);

    assert.equal(report.ran, false);
    assert.equal(report.scanned, 0);
    assert.equal(await redis().provider.client.get(LOCK_KEY), null);
    assert.equal(await db().client.notification.count(), 0);
  });

  // S9: flipped from "installs nothing for reconciliation".
  it('registering the schedules — however often — installs the reconciliation and PA-11 once each', async () => {
    try {
      await registerJobSchedules();
      await registerJobSchedules();

      const schedulers = await maintenanceQueue(
        QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE,
      ).getJobSchedulers();
      assert.deepEqual(
        schedulers.map((s) => s.key).sort(),
        ['notification-event-reconciliation', 'notification-reconciliation'],
        'the event reconciliation and PA-11, exactly once each',
      );
    } finally {
      for (const schedule of JOB_SCHEDULES) {
        await maintenanceQueue(schedule.queue).removeJobScheduler(schedule.name);
      }
    }
  });

  it('a job scheduler outlives the code that registered it: undoing S9 needs removeJobScheduler', async () => {
    const probe = new Queue('f3-s8-rollback-probe', { connection: createQueueConnection() });
    try {
      const install = () =>
        probe.upsertJobScheduler(
          'notification-event-reconciliation',
          { pattern: '* * * * *', tz: SCHEDULE_TIMEZONE },
          { name: 'notification-event-reconciliation' },
        );
      await install();
      await install();
      assert.equal(await probe.getJobSchedulersCount(), 1, 'an upsert, never a second scheduler');

      // "Reverting the code" registers nothing — and removes nothing.
      assert.equal(await probe.getJobSchedulersCount(), 1, 'still scheduled after the revert');

      assert.equal(await probe.removeJobScheduler('notification-event-reconciliation'), true);
      assert.equal(await probe.getJobSchedulersCount(), 0);
    } finally {
      await probe.obliterate({ force: true });
      await probe.close();
    }
  });
});
