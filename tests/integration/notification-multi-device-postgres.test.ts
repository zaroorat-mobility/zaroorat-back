import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { container } from '../../src/core/di.js';
import { FIXED_OTP, bootApp, db, resetState } from './helpers/harness.js';
import type { DeviceRepository } from '../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../src/modules/notifications/repositories/notification.repository.js';
import {
  NotificationDeliveryJob,
  SEND_LEASE_SECONDS,
} from '../../src/modules/notifications/jobs/notification-delivery.job.js';
import { FcmPushProvider } from '../../src/integrations/firebase/fcm-push.provider.js';
import type {
  PushMessage,
  PushProvider,
  PushSendResult,
} from '../../src/modules/notifications/providers/push.provider.js';

/// Phase 3 — multi-device delivery and dynamic offer TTL against real PostgreSQL.
///
/// Real repositories, real transactions and row locks, real conditional
/// updates. Only the provider is scripted. Where invalid-token cleanup matters
/// the real FcmPushProvider runs over a scripted Firebase app, so the token is
/// cleared by the production code path and checked with SQL.

const USER_A = '+919876532001';
const USER_B = '+919876532002';

type Script = (message: PushMessage) => PushSendResult | Promise<PushSendResult>;

function scriptedProvider(script: Script): PushProvider & { sent: PushMessage[] } {
  const sent: PushMessage[] = [];
  return {
    name: 'scripted',
    sent,
    async sendPush(message) {
      sent.push(message);
      return script(message);
    },
  };
}

const ok: Script = (m) => ({ accepted: true, provider: 'scripted', providerRef: `ref-${m.to}` });

/// The real FCM provider over a Firebase app whose `send` fails for the given
/// tokens with FCM's own "not registered" code.
function fcmWithDeadTokens(dead: Set<string>): { provider: FcmPushProvider; sent: string[] } {
  const sent: string[] = [];
  const app = {
    messaging: () => ({
      send: async (message: { token: string }) => {
        sent.push(message.token);
        if (dead.has(message.token)) {
          throw Object.assign(new Error('not registered'), {
            code: 'messaging/registration-token-not-registered',
          });
        }
        return `msg-${message.token}`;
      },
    }),
  };
  const provider = new FcmPushProvider(
    app as never,
    container.resolve<DeviceRepository>('deviceRepository'),
  );
  return { provider, sent };
}

describe('Phase 3 notification delivery against real PostgreSQL', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  const notifications = (): NotificationRepository =>
    container.resolve<NotificationRepository>('notificationRepository');
  const devicesRepo = (): DeviceRepository =>
    container.resolve<DeviceRepository>('deviceRepository');
  const jobWith = (provider: PushProvider) =>
    new NotificationDeliveryJob(notifications(), devicesRepo(), provider);

  async function userId(phoneNumber: string): Promise<string> {
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

  let seenOffset = 0;
  async function device(
    owner: string,
    fcmToken: string | null,
    trustState: 'REGISTERED' | 'REVOKED' = 'REGISTERED',
  ): Promise<string> {
    seenOffset += 1;
    const row = await db().client.userDevice.create({
      data: {
        userId: owner,
        deviceId: `dev-${randomUUID()}`,
        fcmToken,
        trustState,
        lastSeenAt: new Date(Date.now() - seenOffset * 1000),
      },
    });
    return row.id;
  }

  async function notify(
    owner: string,
    data: Record<string, string> = {},
    key: string = randomUUID(),
  ) {
    const created = await notifications().createNotificationWithDelivery({
      userId: owner,
      eventKey: data.type ?? 'ride.accepted',
      idempotencyKey: key,
      title: 'T',
      body: 'B',
      data: { eventId: key, category: 'TRANSACTIONAL', ...data },
      channel: 'PUSH',
    });
    return { notificationId: created.notification.id, deliveryId: created.delivery!.id };
  }

  async function deliveries(notificationId: string) {
    return db().client.$queryRaw<
      Array<{
        id: string;
        device_id: string | null;
        status: string;
        attempts: number;
        error_code: string | null;
      }>
    >`SELECT id, device_id, status::text AS status, attempts, error_code
      FROM notification_deliveries WHERE notification_id = ${notificationId}::uuid
      ORDER BY created_at, id`;
  }

  async function notificationStatus(id: string): Promise<string> {
    const rows = await db().client.$queryRaw<Array<{ status: string }>>`
      SELECT status::text AS status FROM notifications WHERE id = ${id}::uuid`;
    return rows[0]!.status;
  }

  async function tokenOf(deviceRowId: string): Promise<string | null> {
    const rows = await db().client.$queryRaw<Array<{ fcm_token: string | null }>>`
      SELECT fcm_token FROM user_devices WHERE id = ${deviceRowId}::uuid`;
    return rows[0]!.fcm_token;
  }

  // ── Device selection and per-device delivery ─────────────────────────────

  describe('multi-device delivery', () => {
    it('1 · one device: one delivery bound to it, SENT', async () => {
      const u = await userId(USER_A);
      const d1 = await device(u, 'tok-1');
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      const result = await jobWith(provider).run(job);

      assert.equal(result.delivered, true);
      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, job.deliveryId, 'the consumer-created delivery is the one bound');
      assert.equal(rows[0]!.device_id, d1);
      assert.equal(rows[0]!.status, 'SENT');
      assert.deepEqual(
        provider.sent.map((m) => m.to),
        ['tok-1'],
      );
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
    });

    it('2 · two valid devices: one delivery each, both SENT, each bound to its row', async () => {
      const u = await userId(USER_A);
      const d1 = await device(u, 'tok-1');
      const d2 = await device(u, 'tok-2');
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      await jobWith(provider).run(job);

      const rows = await deliveries(job.notificationId);
      assert.deepEqual(new Set(rows.map((r) => r.device_id)), new Set([d1, d2]));
      assert.ok(rows.every((r) => r.status === 'SENT'));
      assert.deepEqual(provider.sent.map((m) => m.to).sort(), ['tok-1', 'tok-2']);
      // Each device's payload carries its own delivery id.
      assert.deepEqual(
        new Set(provider.sent.map((m) => m.data?.deliveryId)),
        new Set(rows.map((r) => r.id)),
      );
    });

    it('3 · invalid + valid: invalid FAILED and its token cleared, valid SENT, notification SENT', async () => {
      const u = await userId(USER_A);
      const dead = await device(u, 'tok-dead');
      const live = await device(u, 'tok-live');
      const job = await notify(u);
      const fcm = fcmWithDeadTokens(new Set(['tok-dead']));

      const result = await jobWith(fcm.provider).run(job);

      assert.equal(result.delivered, true);
      const rows = await deliveries(job.notificationId);
      const byDevice = Object.fromEntries(rows.map((r) => [r.device_id, r]));
      assert.equal(byDevice[dead]!.status, 'FAILED');
      assert.equal(byDevice[dead]!.error_code, 'messaging/registration-token-not-registered');
      assert.equal(byDevice[live]!.status, 'SENT');
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
      assert.equal(await tokenOf(dead), null, 'invalid token cleared by the real provider');
      assert.equal(await tokenOf(live), 'tok-live');
    });

    it('4 · all devices invalid: every delivery FAILED, notification FAILED, no retry', async () => {
      const u = await userId(USER_A);
      const a = await device(u, 'tok-x');
      const b = await device(u, 'tok-y');
      const job = await notify(u);
      const fcm = fcmWithDeadTokens(new Set(['tok-x', 'tok-y']));

      const result = await jobWith(fcm.provider).run(job); // must not throw

      assert.equal(result.delivered, false);
      assert.ok((await deliveries(job.notificationId)).every((r) => r.status === 'FAILED'));
      assert.equal(await notificationStatus(job.notificationId), 'FAILED');
      assert.equal(await tokenOf(a), null);
      assert.equal(await tokenOf(b), null);
    });

    it('5 · only revoked devices: NO_ACTIVE_DEVICE, nothing sent, revoked rows untouched', async () => {
      const u = await userId(USER_A);
      const r1 = await device(u, 'tok-r1', 'REVOKED');
      await device(u, 'tok-r2', 'REVOKED');
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      const result = await jobWith(provider).run(job);

      assert.equal(result.error, 'NO_ACTIVE_DEVICE');
      assert.equal(provider.sent.length, 0);
      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 1, 'no delivery created for a revoked device');
      assert.equal(rows[0]!.device_id, null);
      assert.equal(rows[0]!.status, 'FAILED');
      assert.equal(rows[0]!.error_code, 'NO_ACTIVE_DEVICE');
      assert.equal(await notificationStatus(job.notificationId), 'FAILED');
      assert.equal(await tokenOf(r1), 'tok-r1');
    });

    it('6 · devices without tokens are not targeted', async () => {
      const u = await userId(USER_A);
      await device(u, null);
      await device(u, null);
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      const result = await jobWith(provider).run(job);

      assert.equal(result.error, 'NO_ACTIVE_DEVICE');
      assert.equal(provider.sent.length, 0);
      assert.equal((await deliveries(job.notificationId)).length, 1);
    });

    it('only eligible devices are targeted when mixed with revoked and tokenless rows', async () => {
      const u = await userId(USER_A);
      const live = await device(u, 'tok-live');
      await device(u, 'tok-revoked', 'REVOKED');
      await device(u, null);
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      await jobWith(provider).run(job);

      const rows = await deliveries(job.notificationId);
      assert.deepEqual(
        rows.map((r) => r.device_id),
        [live],
      );
      assert.deepEqual(
        provider.sent.map((m) => m.to),
        ['tok-live'],
      );
    });

    it('one token on two rows of the same user is pushed once', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-same');
      await device(u, 'tok-same');
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      await jobWith(provider).run(job);

      assert.equal(provider.sent.length, 1);
      assert.equal((await deliveries(job.notificationId)).length, 1);
    });

    it('a device that logged out after planning is not sent to on the retry', async () => {
      const u = await userId(USER_A);
      const a = await device(u, 'tok-a');
      await device(u, 'tok-b');
      const job = await notify(u);
      const flaky = scriptedProvider((m) =>
        m.to === 'tok-a'
          ? { accepted: false, provider: 'scripted', error: 'messaging/server-unavailable' }
          : ok(m),
      );
      await assert.rejects(() => jobWith(flaky).run(job), /Transient FCM push failure/);

      await db().client.userDevice.update({ where: { id: a }, data: { fcmToken: null } });
      const provider = scriptedProvider(ok);
      await jobWith(provider).run(job);

      assert.equal(provider.sent.length, 0);
      const rowA = (await deliveries(job.notificationId)).find((r) => r.device_id === a)!;
      assert.equal(rowA.status, 'FAILED');
      assert.equal(rowA.error_code, 'DEVICE_INELIGIBLE');
    });
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('7 · a duplicate job run sends nothing again and adds no deliveries', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      await device(u, 'tok-2');
      const job = await notify(u);
      const provider = scriptedProvider(ok);

      await jobWith(provider).run(job);
      await jobWith(provider).run(job);
      await jobWith(provider).run(job);

      assert.equal(provider.sent.length, 2, 'one send per device, however many runs');
      assert.equal((await deliveries(job.notificationId)).length, 2);
    });

    it('8 · worker retry sends only to the device that failed transiently', async () => {
      const u = await userId(USER_A);
      const a = await device(u, 'tok-a');
      const b = await device(u, 'tok-b');
      const job = await notify(u);
      let aFails = true;
      const provider = scriptedProvider((m) =>
        m.to === 'tok-a' && aFails
          ? { accepted: false, provider: 'scripted', error: 'messaging/server-unavailable' }
          : ok(m),
      );

      await assert.rejects(() => jobWith(provider).run(job), /Transient FCM push failure/);
      let rows = await deliveries(job.notificationId);
      const rowOf = (id: string) => rows.find((r) => r.device_id === id)!;
      assert.equal(rowOf(a).status, 'QUEUED', 'a stays QUEUED for the retry');
      assert.equal(rowOf(a).error_code, 'messaging/server-unavailable');
      assert.equal(rowOf(b).status, 'SENT');
      assert.equal(await notificationStatus(job.notificationId), 'SENT', 'one device got it');

      aFails = false;
      await jobWith(provider).run(job);

      rows = await deliveries(job.notificationId);
      assert.equal(rowOf(a).status, 'SENT');
      assert.equal(rowOf(a).attempts, 2);
      assert.equal(rowOf(b).attempts, 1, 'b was not sent to again');
      assert.deepEqual(
        provider.sent.map((m) => m.to),
        ['tok-a', 'tok-b', 'tok-a'],
      );
    });

    it('exhausted retries fail only the QUEUED device and keep the notification SENT', async () => {
      const u = await userId(USER_A);
      const a = await device(u, 'tok-a');
      const b = await device(u, 'tok-b');
      const job = await notify(u);
      const provider = scriptedProvider((m) =>
        m.to === 'tok-a'
          ? { accepted: false, provider: 'scripted', error: 'messaging/server-unavailable' }
          : ok(m),
      );
      await assert.rejects(() => jobWith(provider).run(job));

      await jobWith(provider).markExhausted(job.notificationId, 'gave up');

      const rows = await deliveries(job.notificationId);
      assert.equal(rows.find((r) => r.device_id === a)!.status, 'FAILED');
      assert.equal(rows.find((r) => r.device_id === b)!.status, 'SENT');
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
    });

    it('11 · notification-level: the same event+user+channel key creates one notification', async () => {
      const u = await userId(USER_A);
      const key = `evt-1:ride.accepted:${u}:PUSH`;
      const first = await notify(u, {}, key);
      const second = await notifications().createNotificationWithDelivery({
        userId: u,
        idempotencyKey: key,
        title: 'T',
        channel: 'PUSH',
      });
      assert.equal(second.isDuplicate, true);
      assert.equal(second.notification.id, first.notificationId);
    });

    it('12 · device-level: concurrent planning binds each device exactly once', async () => {
      const u = await userId(USER_A);
      const ids = [await device(u, 't1'), await device(u, 't2'), await device(u, 't3')];
      const job = await notify(u);

      await Promise.all(
        Array.from({ length: 6 }, () =>
          notifications().planDeviceDeliveries(job.notificationId, ids),
        ),
      );

      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 3);
      assert.deepEqual(new Set(rows.map((r) => r.device_id)), new Set(ids));
    });

    it('12 · a planner arriving while another planner holds the notification adds nothing', async () => {
      // Deterministic version of the race above: this transaction plays the
      // planner that got there first — lock, bind both devices — and holds its
      // lock until the real planner is provably blocked behind it. Without the
      // row lock the real planner would already have read the unplanned state
      // and would add a second delivery for the second device.
      const u = await userId(USER_A);
      const ids = [await device(u, 't1'), await device(u, 't2')];
      const job = await notify(u);
      let planning: Promise<unknown> | undefined;

      await db().client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM notifications WHERE id = ${job.notificationId}::uuid FOR UPDATE`;
          await tx.notificationDelivery.update({
            where: { id: job.deliveryId },
            data: { deviceId: ids[0]! },
          });
          await tx.notificationDelivery.create({
            data: {
              notificationId: job.notificationId,
              channel: 'PUSH',
              deviceId: ids[1]!,
              status: 'QUEUED',
            },
          });

          planning = notifications().planDeviceDeliveries(job.notificationId, ids);
          // Wait for the condition, not for time: until a backend is waiting on a lock.
          for (let i = 0; i < 500; i += 1) {
            const [row] = await db().client.$queryRaw<Array<{ n: number }>>`
              SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
            if (row && row.n > 0) break;
            await new Promise((resolve) => setImmediate(resolve));
          }
        },
        { timeout: 20_000 },
      );
      await planning;

      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 2, 'no duplicate delivery for either device');
      assert.deepEqual(new Set(rows.map((r) => r.device_id)), new Set(ids));
    });

    it('13 · concurrent job runs send to each device exactly once', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      await device(u, 'tok-2');
      const job = await notify(u);
      // Slow provider: widens the window in which the runs overlap. Correctness
      // does not depend on the delay — the conditional claim decides.
      const provider = scriptedProvider(async (m) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return ok(m);
      });

      const runs = await Promise.allSettled([
        jobWith(provider).run(job),
        jobWith(provider).run(job),
        jobWith(provider).run(job),
      ]);

      assert.deepEqual(provider.sent.map((m) => m.to).sort(), ['tok-1', 'tok-2']);
      const rows = await deliveries(job.notificationId);
      assert.ok(rows.every((r) => r.status === 'SENT' && r.attempts === 1));
      // A run that found a delivery leased by a run still sending does not
      // complete (F1): it fails, retryably, and for that reason only.
      for (const run of runs) {
        if (run.status === 'rejected') {
          assert.match(String(run.reason), /Delivery lease held by another attempt/);
        }
      }
      // BullMQ's retry of such a run finds everything finished and sends nothing.
      await jobWith(provider).run(job);
      assert.equal(provider.sent.length, 2);
    });
  });

  // ── F1 · lease recovery ──────────────────────────────────────────────────
  //
  // A delivery whose lease is held — by a worker that crashed after claiming, or
  // one still sending — must be retried, never completed as done; a provider
  // that throws must give its lease back. Real SQL throughout: the only thing a
  // test simulates is the passage of time, by moving a lease's expiry into the
  // past, since the lease is measured on the database clock.

  describe('F1 · delivery lease recovery', () => {
    async function expireLease(deliveryId: string): Promise<void> {
      await db().client.$executeRaw`
        UPDATE notification_deliveries
        SET metadata = jsonb_set(metadata, '{leaseUntil}', to_jsonb(now() - interval '1 second'))
        WHERE id = ${deliveryId}::uuid`;
    }

    async function leaseOf(deliveryId: string): Promise<string | null> {
      const rows = await db().client.$queryRaw<Array<{ lease: string | null }>>`
        SELECT metadata->>'leaseUntil' AS lease FROM notification_deliveries
        WHERE id = ${deliveryId}::uuid`;
      return rows[0]!.lease;
    }

    it('a crashed worker’s live lease fails the retry retryably; the delivery is reclaimed once it expires', async () => {
      const u = await userId(USER_A);
      const d = await device(u, 'tok-1');
      const job = await notify(u);

      // Worker A plans and claims, then crashes: no send, no finalize, no release.
      await notifications().planDeviceDeliveries(job.notificationId, [d]);
      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), 1);

      // Worker B — BullMQ's stalled re-run and its retries — while A's lease is live.
      const provider = scriptedProvider(ok);
      for (let retry = 0; retry < 2; retry += 1) {
        await assert.rejects(
          () => jobWith(provider).run(job),
          /Delivery lease held by another attempt/,
          'must fail retryably, not complete',
        );
      }
      assert.equal(provider.sent.length, 0, 'B cannot claim a live lease');
      let rows = await deliveries(job.notificationId);
      assert.equal(rows[0]!.status, 'QUEUED', 'not FAILED, not finalized');
      assert.equal(rows[0]!.attempts, 1, 'B never claimed');
      assert.equal(await notificationStatus(job.notificationId), 'QUEUED');

      await expireLease(job.deliveryId);
      const result = await jobWith(provider).run(job);

      assert.equal(result.delivered, true);
      assert.deepEqual(
        provider.sent.map((m) => m.to),
        ['tok-1'],
        'sent exactly once',
      );
      rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 1, 'reclaimed the same row; no new delivery');
      assert.equal(rows[0]!.id, job.deliveryId);
      assert.equal(rows[0]!.status, 'SENT');
      assert.equal(rows[0]!.attempts, 2);
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
    });

    it('a provider that throws releases its lease, keeps the delivery QUEUED, and the retry sends', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      const job = await notify(u);
      let throws = 1;
      const provider = scriptedProvider((m) => {
        if (throws > 0) {
          throws -= 1;
          throw new Error('provider exploded');
        }
        return ok(m);
      });

      await assert.rejects(() => jobWith(provider).run(job), /provider exploded/);

      let rows = await deliveries(job.notificationId);
      assert.equal(rows[0]!.status, 'QUEUED');
      assert.equal(rows[0]!.attempts, 1);
      assert.equal(rows[0]!.error_code, 'PROVIDER_EXCEPTION');
      assert.equal(await leaseOf(job.deliveryId), null, 'lease released');
      assert.equal(await notificationStatus(job.notificationId), 'QUEUED');

      // The retry does not wait out a lease: it claims immediately and sends.
      const result = await jobWith(provider).run(job);

      assert.equal(result.delivered, true);
      assert.equal(provider.sent.length, 2, 'one call threw, one succeeded');
      rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'SENT');
      assert.equal(rows[0]!.attempts, 2);
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
    });

    it('repeated provider exceptions use up the retries, then the delivery and notification fail', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      const job = await notify(u);
      const provider = scriptedProvider(() => {
        throw new Error('provider exploded');
      });

      // The four attempts NOTIFICATION_JOB_OPTIONS allows. Each one claims — the
      // previous lease was released — so none of them is refused as busy.
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await assert.rejects(() => jobWith(provider).run(job), /provider exploded/);
      }
      assert.equal((await deliveries(job.notificationId))[0]!.attempts, 4);

      // What the worker's `failed` handler does once attempts are exhausted.
      await jobWith(provider).markExhausted(job.notificationId, 'provider exploded');

      const row = (await deliveries(job.notificationId))[0]!;
      assert.equal(row.status, 'FAILED');
      assert.equal(await notificationStatus(job.notificationId), 'FAILED');
    });

    it('a throw on one device does not strand the other; the retry finishes both, once each', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-a');
      await device(u, 'tok-b');
      const job = await notify(u);
      let aThrows = true;
      const provider = scriptedProvider((m) => {
        if (m.to === 'tok-a' && aThrows) {
          aThrows = false;
          throw new Error('provider exploded');
        }
        return ok(m);
      });

      await assert.rejects(() => jobWith(provider).run(job), /provider exploded/);
      await jobWith(provider).run(job);

      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.status === 'SENT'));
      // tok-a: the call that threw plus its successful retry; tok-b: once, never again.
      const calls: Record<string, number> = {};
      for (const m of provider.sent) calls[m.to] = (calls[m.to] ?? 0) + 1;
      assert.deepEqual(calls, { 'tok-a': 2, 'tok-b': 1 });
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
    });

    it('an active lease blocks a claim; an expired one is reclaimed on the same row', async () => {
      const u = await userId(USER_A);
      const d = await device(u, 'tok-1');
      const job = await notify(u);
      await notifications().planDeviceDeliveries(job.notificationId, [d]);

      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), 1);
      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), null, 'live lease');

      await expireLease(job.deliveryId);
      assert.equal(
        await notifications().claimDelivery(job.deliveryId, 60),
        2,
        'expired → reclaimed',
      );

      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 1, 'no new delivery row');
      assert.equal(rows[0]!.id, job.deliveryId);
      assert.equal(
        await notifications().finalizeDelivery(job.deliveryId, { status: 'SENT' }),
        true,
      );
      assert.equal((await deliveries(job.notificationId))[0]!.status, 'SENT');
    });

    it('a worker whose lease was taken over cannot release the new owner’s lease', async () => {
      const u = await userId(USER_A);
      const d = await device(u, 'tok-1');
      const job = await notify(u);
      await notifications().planDeviceDeliveries(job.notificationId, [d]);

      const a = await notifications().claimDelivery(job.deliveryId, 60); // worker A
      await expireLease(job.deliveryId);
      const b = await notifications().claimDelivery(job.deliveryId, 60); // worker B takes over
      assert.deepEqual([a, b], [1, 2]);

      // A wakes up late and tries to release: its attempt no longer matches.
      assert.equal(await notifications().releaseDelivery(job.deliveryId, a!, 'E', 'late'), false);
      assert.equal(
        await notifications().claimDelivery(job.deliveryId, 60),
        null,
        'B still holds it',
      );

      assert.equal(await notifications().releaseDelivery(job.deliveryId, b!, 'E', 'b'), true);
      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), 3);
    });

    // ── The lease must expire inside BullMQ's retry budget ──────────────────
    //
    // Time is advanced by moving the lease's end earlier by the simulated
    // elapsed seconds — the same thing the database clock moving forward would
    // do to `leaseUntil < now()`. The claim itself is the real conditional UPDATE.

    async function advance(deliveryId: string, seconds: number): Promise<void> {
      await db().client.$executeRaw`
        UPDATE notification_deliveries
        SET metadata = jsonb_set(
          metadata,
          '{leaseUntil}',
          to_jsonb((metadata->>'leaseUntil')::timestamptz - make_interval(secs => ${seconds}::double precision))
        )
        WHERE id = ${deliveryId}::uuid AND metadata ? 'leaseUntil'`;
    }

    async function leaseRemainingSeconds(deliveryId: string): Promise<number> {
      const rows = await db().client.$queryRaw<Array<{ s: number }>>`
        SELECT EXTRACT(EPOCH FROM ((metadata->>'leaseUntil')::timestamptz - now()))::float8 AS s
        FROM notification_deliveries WHERE id = ${deliveryId}::uuid`;
      return rows[0]!.s;
    }

    it('worst case: a stalled re-run at the early edge of the stall window still reclaims within the retry budget', async () => {
      const u = await userId(USER_A);
      const d = await device(u, 'tok-1');
      const job = await notify(u);
      await notifications().planDeviceDeliveries(job.notificationId, [d]);

      // Worker A claims exactly as the job does, then crashes.
      assert.equal(await notifications().claimDelivery(job.deliveryId, SEND_LEASE_SECONDS), 1);
      const remaining = await leaseRemainingSeconds(job.deliveryId);
      assert.ok(
        remaining > SEND_LEASE_SECONDS - 2 && remaining <= SEND_LEASE_SECONDS,
        `lease is live for ${SEND_LEASE_SECONDS}s on the database clock (got ${remaining})`,
      );

      // BullMQ 6 defaults, seconds after the crash. lockDuration 30s renewed every
      // 15s → the lock lapses 15–30s after the crash; the stalled check runs every
      // 30s → the re-run lands 15–60s after it. Earliest edge: 15s. A stalled
      // re-run does not consume an attempt, so it and the three retries of
      // NOTIFICATION_JOB_OPTIONS (attempts 4, exponential 5s) follow at
      // +0, +5, +10, +20s: 15, 20, 30 and 50s after the crash.
      const schedule = [15, 20, 30, 50];
      const provider = scriptedProvider(ok);
      let elapsed = 0;
      let sentAt: number | null = null;
      const refused: number[] = [];

      for (const at of schedule) {
        await advance(job.deliveryId, at - elapsed);
        elapsed = at;
        try {
          await jobWith(provider).run(job);
          sentAt = at;
          break;
        } catch (err) {
          assert.match(String(err), /Delivery lease held by another attempt/);
          refused.push(at);
        }
      }

      assert.ok(refused.includes(15), 'the first re-run finds the lease still live');
      assert.notEqual(
        sentAt,
        null,
        `lease outlived every retry (refused at ${refused.join(', ')}s)`,
      );
      assert.deepEqual(
        provider.sent.map((m) => m.to),
        ['tok-1'],
        'sent exactly once',
      );
      const rows = await deliveries(job.notificationId);
      assert.equal(rows.length, 1, 'no second delivery row');
      assert.equal(rows[0]!.id, job.deliveryId, 'the same row was reclaimed');
      assert.equal(rows[0]!.attempts, 2, "A's claim and the reclaim");
      assert.equal(rows[0]!.status, 'SENT');
      assert.equal(await notificationStatus(job.notificationId), 'SENT');
    });

    it(`boundary: a ${SEND_LEASE_SECONDS}s lease blocks a claim while live and permits it once expired`, async () => {
      const u = await userId(USER_A);
      const d = await device(u, 'tok-1');
      const job = await notify(u);
      await notifications().planDeviceDeliveries(job.notificationId, [d]);
      assert.equal(await notifications().claimDelivery(job.deliveryId, SEND_LEASE_SECONDS), 1);

      await advance(job.deliveryId, SEND_LEASE_SECONDS - 1); // 1s left
      assert.equal(
        await notifications().claimDelivery(job.deliveryId, SEND_LEASE_SECONDS),
        null,
        'still live 1s before expiry',
      );

      await advance(job.deliveryId, 2); // 1s past expiry
      assert.equal(
        await notifications().claimDelivery(job.deliveryId, SEND_LEASE_SECONDS),
        2,
        'reclaimable once expired',
      );
      assert.equal((await deliveries(job.notificationId)).length, 1);
    });
  });

  // ── State machine ────────────────────────────────────────────────────────

  describe('delivery state machine', () => {
    it('a terminal delivery can be neither claimed nor finalized again', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      const job = await notify(u);
      await jobWith(scriptedProvider(ok)).run(job);

      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), null);
      assert.equal(
        await notifications().finalizeDelivery(job.deliveryId, {
          status: 'FAILED',
          errorCode: 'X',
        }),
        false,
      );
      assert.equal(
        (await deliveries(job.notificationId))[0]!.status,
        'SENT',
        'SENT is never regressed',
      );
    });

    it('a held lease blocks a second claim until it is released', async () => {
      const u = await userId(USER_A);
      const d = await device(u, 'tok-1');
      const job = await notify(u);
      await notifications().planDeviceDeliveries(job.notificationId, [d]);

      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), 1);
      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), null);
      await notifications().releaseDelivery(job.deliveryId, 1, 'E', 'transient');
      assert.equal(await notifications().claimDelivery(job.deliveryId, 60), 2);
    });
  });

  // ── Phase 3A · dynamic ride-offer TTL ────────────────────────────────────

  describe('ride-offer TTL', () => {
    const offer = (expiresAt: string) => ({
      type: 'ride.dispatch.offered',
      category: 'RIDE_OFFER',
      dispatchId: 'dsp-1',
      expiresAt,
    });

    it('sends with the remaining lifetime as TTL and the offer expiry for APNs', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      const job = await notify(u, offer('2026-09-24T12:00:05.000Z'));
      const provider = scriptedProvider(ok);

      await jobWith(provider).run(job, () => now);

      assert.equal(provider.sent[0]!.ttlMs, 5_000);
      assert.equal(provider.sent[0]!.expiresAt?.toISOString(), '2026-09-24T12:00:05.000Z');
    });

    it('does not send an offer that has expired, and does not retry it', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      const job = await notify(u, offer('2026-09-24T12:00:00.000Z'));
      const provider = scriptedProvider(ok);

      const result = await jobWith(provider).run(job, () => Date.parse('2026-09-24T12:00:00.000Z'));

      assert.equal(result.delivered, false);
      assert.equal(provider.sent.length, 0);
      const row = (await deliveries(job.notificationId))[0]!;
      assert.equal(row.status, 'FAILED');
      assert.equal(row.error_code, 'OFFER_EXPIRED');
      assert.equal(await notificationStatus(job.notificationId), 'FAILED');
    });

    it('a retry that lands after the window closed sends nothing', async () => {
      const u = await userId(USER_A);
      await device(u, 'tok-1');
      const t0 = Date.parse('2026-09-24T12:00:00.000Z');
      const job = await notify(u, offer('2026-09-24T12:00:10.000Z'));
      const flaky = scriptedProvider(() => ({
        accepted: false,
        provider: 'scripted',
        error: 'messaging/server-unavailable',
      }));
      await assert.rejects(() => jobWith(flaky).run(job, () => t0));

      // BullMQ's first backoff is 5s, the second 10s: the retry is past the window.
      const provider = scriptedProvider(ok);
      await jobWith(provider).run(job, () => t0 + 15_000);

      assert.equal(provider.sent.length, 0);
      assert.equal((await deliveries(job.notificationId))[0]!.error_code, 'OFFER_EXPIRED');
    });
  });

  it('keeps users separate: B’s notification never reaches A’s devices', async () => {
    const a = await userId(USER_A);
    const b = await userId(USER_B);
    await device(a, 'tok-a');
    await device(b, 'tok-b');
    const job = await notify(b);
    const provider = scriptedProvider(ok);

    await jobWith(provider).run(job);

    assert.deepEqual(
      provider.sent.map((m) => m.to),
      ['tok-b'],
    );
  });
});
