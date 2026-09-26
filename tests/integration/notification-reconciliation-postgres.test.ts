import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Worker, type Job } from 'bullmq';

import { container } from '../../src/core/di.js';
import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';
import type { NotificationRepository } from '../../src/modules/notifications/repositories/notification.repository.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';
import { NotificationDeliveryJob } from '../../src/modules/notifications/jobs/notification-delivery.job.js';
import {
  NotificationReconciliationJob,
  type ReconciliationQueue,
} from '../../src/modules/notifications/jobs/notification-reconciliation.job.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  createQueueConnection,
  notificationsQueue,
} from '../../src/jobs/queues/index.js';

/// PA-11 — the reconciliation sweep against real PostgreSQL and real BullMQ.
///
/// Every job state is produced for real: `add` for waiting/prioritized/delayed,
/// a real Worker for active/failed/completed. No worker runs the delivery job
/// here — the queue only has to hold jobs in known states. The row lock, the
/// conditional selection and BullMQ's duplicate-id handling are all the real ones.

const USER = '+919876533001';
const MINUTE = 60_000;

describe('PA-11 notification reconciliation (PostgreSQL + BullMQ)', () => {
  let app: FastifyInstance;
  let userId: string;
  const workers: Worker[] = [];

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await notificationsQueue().obliterate({ force: true });
    await app.close();
  });
  beforeEach(async () => {
    await notificationsQueue().obliterate({ force: true });
    userId = await login(USER);
    job = newSweep();
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
    await notificationsQueue().obliterate({ force: true });
    await resetState();
  });

  const repo = (): NotificationRepository =>
    container.resolve<NotificationRepository>('notificationRepository');
  // A fresh sweep per test, as a newly started worker process has: the sweep
  // keeps its keyset cursor in memory, and the DI singleton would carry one test's
  // position into the next.
  let job: NotificationReconciliationJob;
  const sweep = (): NotificationReconciliationJob => job;
  const newSweep = (): NotificationReconciliationJob => new NotificationReconciliationJob(repo());
  const queue = () => notificationsQueue();

  async function login(phoneNumber: string): Promise<string> {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber, code: FIXED_OTP, challengeId: sent.json().challengeId },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    return verified.json().user.id as string;
  }

  /// A notification exactly as the consumer persists it, aged by `ageMs`.
  async function stranded(
    opts: { ageMs?: number; eventKey?: string; data?: Record<string, string> } = {},
  ): Promise<{ id: string; deliveryId: string; key: string }> {
    const key = `evt-${randomUUID()}:ride.accepted:${userId}:PUSH`;
    const created = await repo().createNotificationWithDelivery({
      userId,
      eventKey: opts.eventKey ?? 'ride.accepted',
      idempotencyKey: key,
      title: 'T',
      body: 'B',
      data: { eventId: randomUUID(), category: 'TRANSACTIONAL', ...(opts.data ?? {}) },
      channel: 'PUSH',
    });
    await db().client.notification.update({
      where: { id: created.notification.id },
      data: { createdAt: new Date(Date.now() - (opts.ageMs ?? 2 * MINUTE)) },
    });
    return { id: created.notification.id, deliveryId: created.delivery!.id, key };
  }

  async function status(id: string): Promise<string> {
    return (await db().client.notification.findUniqueOrThrow({ where: { id } })).status;
  }

  async function deliveryRows(id: string) {
    return db().client.notificationDelivery.findMany({
      where: { notificationId: id },
      select: { id: true, status: true, errorCode: true, failureReason: true },
    });
  }

  async function jobState(id: string): Promise<string> {
    const job = await queue().getJob(id);
    return job ? job.getState() : 'missing';
  }

  /// Every job in the queue, in any state, that would deliver notification `id`
  /// — counted by what it carries, not by its id, so a duplicate under some
  /// other id is caught too.
  async function jobsFor(id: string): Promise<number> {
    const all = await queue().getJobs([
      'waiting',
      'prioritized',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    return all.filter((j) => j?.data?.notificationId === id).length;
  }

  /// Every job in the queue whose id is `id`, in any state. BullMQ keys jobs by
  /// id, so more than one would mean duplicate work.
  async function jobsWithId(id: string): Promise<number> {
    const all = await queue().getJobs([
      'waiting',
      'prioritized',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    return all.filter((j) => j?.id === id).length;
  }

  /// The consumer's own enqueue, byte for byte in its options.
  async function consumerAdd(id: string, deliveryId: string) {
    return queue().add(
      JOB_NAMES.NOTIFICATION_DELIVERY,
      { notificationId: id, deliveryId },
      { jobId: id, priority: 1 },
    );
  }

  async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  function worker(processor: (job: Job) => Promise<unknown>): Worker {
    const w = new Worker(QUEUE_NAMES.NOTIFICATIONS, processor, {
      connection: createQueueConnection(),
    });
    workers.push(w);
    return w;
  }

  // ── Missing job ──────────────────────────────────────────────────────────

  it('1 · a stranded QUEUED notification with no job is re-enqueued under its own id', async () => {
    const n = await stranded();

    const report = await sweep().run();

    assert.equal(report.reenqueued, 1);
    const job = await queue().getJob(n.id);
    assert.ok(job, 'job exists');
    assert.equal(job.id, n.id, '14 · job id is the notification id');
    assert.equal(job.name, JOB_NAMES.NOTIFICATION_DELIVERY);
    assert.equal(job.data.notificationId, n.id);
    assert.equal(job.data.deliveryId, n.deliveryId);
    assert.equal(await job.getState(), 'prioritized', 'same priority as the consumer');
    assert.equal(await status(n.id), 'QUEUED', 'the worker, not the sweep, sends it');
  });

  it('end to end: the re-enqueued job is delivered by the real delivery job', async () => {
    await db().client.userDevice.create({
      data: {
        userId,
        deviceId: `dev-${randomUUID()}`,
        fcmToken: 'tok-e2e',
        lastSeenAt: new Date(),
      },
    });
    const n = await stranded();
    const sent: string[] = [];
    const delivery = new NotificationDeliveryJob(
      repo(),
      container.resolve<DeviceRepository>('deviceRepository'),
      {
        name: 'scripted',
        async sendPush(message) {
          sent.push(message.to);
          return { accepted: true, provider: 'scripted', providerRef: 'ref-1' };
        },
      },
    );

    await sweep().run();
    worker(async (bullJob) => delivery.run(bullJob.data));
    await waitFor(async () => (await status(n.id)) === 'SENT', 'delivery');

    assert.deepEqual(sent, ['tok-e2e']);
    assert.equal((await deliveryRows(n.id))[0]!.status, 'SENT');
  });

  // ── Live jobs are left alone ─────────────────────────────────────────────

  it('2 · an active job is not re-enqueued', async () => {
    const n = await stranded();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    worker(async () => gate);
    await consumerAdd(n.id, n.deliveryId);
    await waitFor(async () => (await jobState(n.id)) === 'active', 'active');

    const report = await sweep().run();
    release();

    assert.equal(report.skippedActive, 1);
    assert.equal(report.reenqueued, 0);
    assert.equal(await jobsWithId(n.id), 1);
    assert.equal(await status(n.id), 'QUEUED', '10 · the worker’s notification is untouched');
    assert.deepEqual(
      (await deliveryRows(n.id)).map((d) => d.status),
      ['QUEUED'],
    );
  });

  it('3 · waiting and prioritized jobs are not re-enqueued', async () => {
    const plain = await stranded();
    const prioritized = await stranded();
    await queue().add(
      JOB_NAMES.NOTIFICATION_DELIVERY,
      { notificationId: plain.id },
      {
        jobId: plain.id,
      },
    );
    await consumerAdd(prioritized.id, prioritized.deliveryId);
    assert.equal(await jobState(plain.id), 'waiting');
    assert.equal(await jobState(prioritized.id), 'prioritized');

    const report = await sweep().run();

    assert.equal(report.skippedActive, 2);
    assert.equal(report.reenqueued, 0);
    assert.equal(await jobsWithId(plain.id), 1);
    assert.equal(await jobsWithId(prioritized.id), 1);
  });

  it('4 · a delayed job is not re-enqueued', async () => {
    const n = await stranded();
    await queue().add(
      JOB_NAMES.NOTIFICATION_DELIVERY,
      { notificationId: n.id },
      {
        jobId: n.id,
        delay: 10 * MINUTE,
      },
    );

    const report = await sweep().run();

    assert.equal(report.skippedActive, 1);
    assert.equal(await jobState(n.id), 'delayed');
    assert.equal(await jobsWithId(n.id), 1);
  });

  // ── Failed jobs follow BullMQ's own semantics ────────────────────────────

  it('5a · a failed attempt with retries left is `delayed` in BullMQ, and is left alone', async () => {
    const n = await stranded();
    worker(async () => {
      throw new Error('transient');
    });
    await queue().add(
      JOB_NAMES.NOTIFICATION_DELIVERY,
      { notificationId: n.id },
      {
        jobId: n.id,
        attempts: 3,
        backoff: { type: 'fixed', delay: 10 * MINUTE },
      },
    );
    await waitFor(async () => (await jobState(n.id)) === 'delayed', 'retry backoff');
    await Promise.all(workers.splice(0).map((w) => w.close()));

    const report = await sweep().run();

    assert.equal(report.skippedActive, 1);
    assert.equal(report.reenqueued, 0);
    assert.equal(await jobsWithId(n.id), 1);
  });

  it('5b · a terminally failed job is not re-enqueued; the notification settles FAILED', async () => {
    const n = await stranded();
    worker(async () => {
      throw new Error('provider exploded');
    });
    await queue().add(
      JOB_NAMES.NOTIFICATION_DELIVERY,
      { notificationId: n.id },
      {
        jobId: n.id,
        attempts: 1,
      },
    );
    await waitFor(async () => (await jobState(n.id)) === 'failed', 'terminal failure');
    await Promise.all(workers.splice(0).map((w) => w.close()));

    const report = await sweep().run();

    assert.equal(report.settled, 1);
    assert.equal(report.reenqueued, 0);
    assert.equal(await jobState(n.id), 'failed', 'no second run was created');
    assert.equal(await jobsWithId(n.id), 1);
    const [delivery] = await deliveryRows(n.id);
    assert.equal(delivery!.status, 'FAILED');
    assert.match(delivery!.failureReason ?? '', /Exhausted retries: provider exploded/);
    assert.equal(await status(n.id), 'FAILED');
  });

  it('a completed job that left a delivery QUEUED is run again, once', async () => {
    const n = await stranded();
    worker(async () => 'done without finishing');
    await consumerAdd(n.id, n.deliveryId);
    await waitFor(async () => (await jobState(n.id)) === 'completed', 'completion');
    await Promise.all(workers.splice(0).map((w) => w.close()));

    const report = await sweep().run();

    assert.equal(report.reenqueued, 1);
    assert.equal(await jobState(n.id), 'prioritized');
    assert.equal(await jobsWithId(n.id), 1, 'the finished record was replaced, not joined');
  });

  it('a notification whose deliveries are all terminal is settled, not sent again', async () => {
    const n = await stranded();
    await db().client.notificationDelivery.update({
      where: { id: n.deliveryId },
      data: { status: 'SENT' },
    });

    const report = await sweep().run();

    assert.equal(report.settled, 1);
    assert.equal(await jobState(n.id), 'missing');
    assert.equal(await status(n.id), 'SENT');
  });

  // ── Staleness and expiry ─────────────────────────────────────────────────

  it('6 · a recently created notification is not considered stranded', async () => {
    const n = await stranded({ ageMs: 5_000 });

    const report = await sweep().run();

    assert.equal(report.scanned, 0);
    assert.equal(await jobState(n.id), 'missing');
  });

  it('7 · an expired ride offer is settled OFFER_EXPIRED and never enqueued', async () => {
    const n = await stranded({
      eventKey: 'ride.dispatch.offered',
      data: {
        category: 'RIDE_OFFER',
        dispatchId: 'dsp-1',
        expiresAt: new Date(Date.now() - 90_000).toISOString(),
      },
    });

    const report = await sweep().run();

    assert.equal(report.expired, 1);
    assert.equal(report.reenqueued, 0);
    assert.equal(await jobState(n.id), 'missing');
    const [delivery] = await deliveryRows(n.id);
    assert.equal(delivery!.status, 'FAILED');
    assert.equal(delivery!.errorCode, 'OFFER_EXPIRED');
    assert.equal(await status(n.id), 'FAILED');
  });

  it('a notification older than its delivery TTL is settled NOTIFICATION_EXPIRED, not sent', async () => {
    const n = await stranded({ ageMs: 61 * MINUTE }); // TRANSACTIONAL: 1h TTL

    const report = await sweep().run();

    assert.equal(report.expired, 1);
    assert.equal(await jobState(n.id), 'missing');
    assert.equal((await deliveryRows(n.id))[0]!.errorCode, 'NOTIFICATION_EXPIRED');
    assert.equal(await status(n.id), 'FAILED');
  });

  // ── Concurrency ──────────────────────────────────────────────────────────

  it('8 · concurrent sweeps: exactly one enqueue', async () => {
    const n = await stranded();

    // Three sweeps as three worker processes would run them: separate instances.
    const reports = await Promise.all([newSweep().run(), newSweep().run(), newSweep().run()]);

    assert.equal(
      reports.reduce((sum, r) => sum + r.reenqueued, 0),
      1,
      JSON.stringify(reports),
    );
    assert.equal(await jobsWithId(n.id), 1);
  });

  it('8 · a notification locked by another reconciler or a planning worker is skipped', async () => {
    const n = await stranded();
    let outcome: string | undefined;

    await db().client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM notifications WHERE id = ${n.id}::uuid FOR UPDATE`;
      outcome = await sweep().reconcileNotification(n.id, new Date(), queue());
    });

    assert.equal(outcome, 'skipped_locked');
    assert.equal(await jobState(n.id), 'missing', 'nothing done while someone else holds it');

    // Released: the next sweep does the work.
    assert.equal((await sweep().run()).reenqueued, 1);
  });

  // ── The late queue.add ───────────────────────────────────────────────────

  it('9 · the consumer’s late add after the sweep’s add: one job', async () => {
    const n = await stranded();
    await sweep().run();

    const late = await consumerAdd(n.id, n.deliveryId); // the timed-out add finally lands

    assert.equal(late.id, n.id);
    assert.equal(await jobsWithId(n.id), 1, 'BullMQ turned the second add into a no-op');
    assert.equal(await jobsFor(n.id), 1, 'one job delivers this notification');
  });

  it('9 · the consumer’s late add before the sweep: the sweep sees it and does nothing', async () => {
    const n = await stranded();
    await consumerAdd(n.id, n.deliveryId);

    const report = await sweep().run();

    assert.equal(report.skippedActive, 1);
    assert.equal(report.reenqueued, 0);
    assert.equal(await jobsWithId(n.id), 1);
  });

  // ── Bounded work and failure isolation ───────────────────────────────────

  it('11 · a sweep processes at most its batch, oldest first; the next sweep continues', async () => {
    const all = [];
    for (let i = 0; i < 5; i += 1) all.push(await stranded({ ageMs: (10 - i) * MINUTE }));

    const first = await sweep().run(new Date(), { batchSize: 3 });

    assert.equal(first.scanned, 3);
    assert.equal(first.reenqueued, 3);
    for (const n of all.slice(0, 3)) assert.equal(await jobState(n.id), 'prioritized');
    for (const n of all.slice(3)) assert.equal(await jobState(n.id), 'missing');

    // Continues after the first batch instead of re-reading the three it just
    // enqueued — which stay QUEUED until a worker runs them.
    const second = await sweep().run(new Date(), { batchSize: 3 });
    assert.equal(second.scanned, 2);
    assert.equal(second.reenqueued, 2);
    for (const n of all) assert.equal(await jobState(n.id), 'prioritized');

    // The short batch reached the end: the next sweep wraps to the oldest.
    const third = await sweep().run(new Date(), { batchSize: 3 });
    assert.equal(third.scanned, 3);
    assert.equal(third.skippedActive, 3, 'already enqueued rows are recognised, not redone');
    assert.equal(third.reenqueued, 0);
  });

  it('12 · one candidate failing does not stop the others', async () => {
    const bad = await stranded({ ageMs: 5 * MINUTE });
    const good = await stranded({ ageMs: 4 * MINUTE });
    const real = queue();
    const flaky: ReconciliationQueue = {
      getJob: (id: string) =>
        id === bad.id ? Promise.reject(new Error('WRONGTYPE for this key')) : real.getJob(id),
      add: real.add.bind(real),
    };

    const report = await sweep().run(new Date(), { queue: flaky });

    assert.equal(report.errors, 1);
    assert.equal(report.aborted, false);
    assert.equal(report.reenqueued, 1);
    assert.equal(await jobState(good.id), 'prioritized');
    assert.equal(await jobState(bad.id), 'missing');
    assert.equal(await status(bad.id), 'QUEUED', 'the failed candidate is untouched');
  });

  it('13 · an unreachable queue ends the sweep safely and writes nothing', async () => {
    const a = await stranded({ ageMs: 5 * MINUTE });
    const b = await stranded({ ageMs: 4 * MINUTE });
    const unreachable: ReconciliationQueue = {
      getJob: () => new Promise(() => undefined), // Redis gone: never settles
      add: () => new Promise(() => undefined),
    };

    const report = await sweep().run(new Date(), { queue: unreachable });

    assert.equal(report.aborted, true);
    assert.equal(report.errors, 1);
    assert.equal(report.scanned, 1, 'stopped after the first timeout');
    for (const n of [a, b]) {
      assert.equal(await status(n.id), 'QUEUED');
      assert.deepEqual(
        (await deliveryRows(n.id)).map((d) => d.status),
        ['QUEUED'],
      );
    }
  });

  // ── Idempotency across runs ──────────────────────────────────────────────

  it('14/15 · repeated sweeps enqueue once, create no notification and no delivery', async () => {
    const n = await stranded();

    const reports = [];
    for (let i = 0; i < 3; i += 1) reports.push(await sweep().run());

    assert.deepEqual(
      reports.map((r) => r.reenqueued),
      [1, 0, 0],
    );
    assert.deepEqual(
      reports.map((r) => r.skippedActive),
      [0, 1, 1],
    );
    assert.equal(await jobsWithId(n.id), 1);
    assert.equal(await jobsFor(n.id), 1);
    assert.equal(await db().client.notification.count({ where: { idempotencyKey: n.key } }), 1);
    assert.equal((await deliveryRows(n.id)).length, 1);
  });
});
