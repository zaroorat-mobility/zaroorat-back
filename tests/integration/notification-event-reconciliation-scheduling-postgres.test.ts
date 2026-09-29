import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Job, Worker } from 'bullmq';

import { container } from '../../src/core/di.js';
import { config } from '../../src/config/index.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { makeAssignedVehicle, makeDriver, makeRide, makeRideRequest } from './helpers/fixtures.js';
import { bootstrapQueue } from '../../src/bootstrap/queue.bootstrap.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { RedisService } from '../../src/core/cache/RedisService.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  maintenanceQueue,
  notificationsQueue,
} from '../../src/jobs/queues/index.js';
import {
  JOB_SCHEDULES,
  SCHEDULE_TIMEZONE,
  registerJobSchedules,
} from '../../src/jobs/scheduler/index.js';
import { startMaintenanceWorker } from '../../src/jobs/workers/index.js';
import type { NotificationEventReconciliationReport } from '../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S9 — the wired reconciliation against real Redis, BullMQ and PostgreSQL:
/// the worker bootstrap's schedule registration, the maintenance worker running
/// the job through `runMaintenanceJob`, and the documented rollback.

const NAME = JOB_NAMES.NOTIFICATION_EVENT_RECONCILIATION;
const MODE_ENV = 'NOTIFICATION_EVENT_RECONCILIATION_MODE';
const JOB_TIMEOUT_MS = 30_000;

describe('F3 S9 · reconciliation scheduling (Redis + BullMQ + PostgreSQL)', () => {
  let app: FastifyInstance;
  let savedMode: string | undefined;
  let worker: Worker | undefined;

  const redis = (): RedisService => container.resolve<RedisService>('redisService');
  const notificationsMaintenance = () => maintenanceQueue(QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE);

  async function removeAllSchedulers(): Promise<void> {
    for (const schedule of JOB_SCHEDULES) {
      await maintenanceQueue(schedule.queue).removeJobScheduler(schedule.name);
    }
  }

  async function clean(): Promise<void> {
    await worker?.close();
    worker = undefined;
    await removeAllSchedulers();
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
  beforeEach(clean);
  afterEach(async () => {
    await clean();
    await resetState();
  });

  const keys = async () =>
    (await notificationsMaintenance().getJobSchedulers()).map((s) => s.key).sort();

  /// Resolves with the result of the next job called `name` the worker finishes.
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
    const publishedAt = new Date(Date.now() - 2 * 60_000);
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

  // ── Registration ──────────────────────────────────────────────────────────

  it('the worker bootstrap installs one reconciliation scheduler beside PA-11, with its cron in UTC', async () => {
    await bootstrapQueue();
    assert.deepEqual(await keys(), [NAME, JOB_NAMES.NOTIFICATION_RECONCILIATION]);
    const scheduler = (await notificationsMaintenance().getJobSchedulers()).find(
      (s) => s.key === NAME,
    );
    const configured = JOB_SCHEDULES.find((s) => s.name === NAME);
    assert.equal(scheduler?.pattern, configured?.pattern);
    assert.equal(
      scheduler?.pattern,
      process.env.NOTIFICATION_EVENT_RECONCILIATION_CRON ?? '* * * * *',
    );
    assert.equal(scheduler?.tz, SCHEDULE_TIMEZONE);
  });

  it('bootstrapping again and again creates no duplicate, on any queue', async () => {
    await bootstrapQueue();
    await bootstrapQueue();
    await bootstrapQueue();
    assert.equal(await notificationsMaintenance().getJobSchedulersCount(), 2);
    for (const queue of new Set(JOB_SCHEDULES.map((s) => s.queue))) {
      const installed = (await maintenanceQueue(queue).getJobSchedulers()).map((s) => s.key).sort();
      const declared = JOB_SCHEDULES.filter((s) => s.queue === queue)
        .map((s) => s.name)
        .sort();
      assert.deepEqual(installed, declared, queue);
    }
  });

  // ── The worker runs it through runMaintenanceJob ──────────────────────────

  it(
    'the maintenance worker runs it through runMaintenanceJob — mode unset is a dry run',
    { timeout: JOB_TIMEOUT_MS },
    async () => {
      await strandedEvent();
      delete process.env[MODE_ENV];
      worker = startMaintenanceWorker(QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE);
      const pending = nextResult(worker, NAME);
      await notificationsMaintenance().add(NAME, {});

      const report = (await pending) as NotificationEventReconciliationReport;
      assert.equal(report.mode, 'dry-run');
      assert.equal(report.ran, true);
      assert.equal(report.wouldRecover, 1);
      assert.equal(await db().client.notification.count(), 0, 'a dry run writes nothing');
    },
  );

  it('the worker’s run with the mode off does nothing', { timeout: JOB_TIMEOUT_MS }, async () => {
    await strandedEvent();
    process.env[MODE_ENV] = 'off';
    worker = startMaintenanceWorker(QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE);
    const pending = nextResult(worker, NAME);
    await notificationsMaintenance().add(NAME, {});

    const report = (await pending) as NotificationEventReconciliationReport;
    assert.equal(report.mode, 'off');
    assert.equal(report.ran, false);
    assert.equal(await db().client.notification.count(), 0);
  });

  // ── Rollback ──────────────────────────────────────────────────────────────

  it('the runbook’s rollback command removes the reconciliation scheduler and leaves PA-11', async () => {
    await registerJobSchedules();
    assert.deepEqual(await keys(), [NAME, JOB_NAMES.NOTIFICATION_RECONCILIATION]);

    // The command exactly as RB-09 documents it.
    const runbook = readFileSync(
      path.join(process.cwd(), 'docs/14_Operations/02_runbooks.md'),
      'utf8',
    );
    const rb09 = runbook.slice(runbook.indexOf('## RB-09'));
    const script = /node -e "([^"]+)"/.exec(rb09)?.[1];
    assert.ok(script, 'RB-09 documents a node -e rollback command');
    const output = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, REDIS_URL: config.redis.url },
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    assert.match(output, /removed: true/);
    assert.deepEqual(await keys(), [JOB_NAMES.NOTIFICATION_RECONCILIATION]);

    // Re-registering restores exactly one — a redeploy after a rollback is safe.
    await registerJobSchedules();
    assert.deepEqual(await keys(), [NAME, JOB_NAMES.NOTIFICATION_RECONCILIATION]);
  });
});
