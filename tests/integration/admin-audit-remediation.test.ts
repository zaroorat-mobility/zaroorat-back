import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Worker } from 'bullmq';
import type { FastifyInstance, InjectOptions } from 'fastify';

import {
  bootApp,
  bootEventConsumers,
  db,
  drainOutbox,
  FIXED_OTP,
  loginAs,
  resetState,
} from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import {
  allowAuditWrites,
  auditRows,
  refuseAuditWrites,
  results,
  SPOOFED_ACTOR_ID,
} from './helpers/audit.js';
import { container } from '../../src/core/di.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import {
  createQueueConnection,
  JOB_NAMES,
  otpQueue,
  QUEUE_NAMES,
} from '../../src/jobs/queues/index.js';
import { enqueueOtpDelivery } from '../../src/jobs/producers/index.js';
import { getAlertAcks } from '../../src/modules/admin/monitoring-management/monitoring.store.js';
import { MissingAuditActorError, type AuditActor } from '../../src/modules/admin/audit/index.js';
import type { EpochService } from '../../src/modules/auth/services/token/epoch.service.js';
import type { AdminPlatformSettingsService } from '../../src/modules/admin/system-settings/platform/services/admin-platform-settings.service.js';
import type { AdminMapSettingsService } from '../../src/modules/admin/system-settings/map/services/admin-map-settings.service.js';
import type { AdminSmsSettingsService } from '../../src/modules/admin/system-settings/integrations/services/admin-sms-settings.service.js';
import {
  assertRestrictedDatabaseRole,
  auditTrailRewriteRights,
} from '../../src/bootstrap/database.bootstrap.js';

const ADMIN_PHONE = '+919876549001';
const OTHER_ADMIN_PHONE = '+919876549002';
const SUPPORT_PHONE = '+919876549003';
const TARGET_PHONE = '+919876549004';
const SUBJECT_PHONE = '+919876549005';
const OTHER_SUBJECT_PHONE = '+919876549006';
const PASSWORD = 'Admin@12345';
const USER_AGENT = 'audit-remediation-test/1.0';

type Metadata = {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  notes?: string;
  result?: string;
};
const meta = (row: { metadata: unknown }) => (row.metadata ?? {}) as Metadata;

interface Staff {
  userId: string;
  headers: Record<string, string>;
}

/// Every string, number and key anywhere in `value`, for "absent recursively" checks.
function everyLeaf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => everyLeaf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      everyLeaf(v, out);
    }
  }
  return out;
}

describe('admin audit remediation (integration)', () => {
  let app: FastifyInstance;
  let flagsSnapshot: Array<{
    key: string;
    status: string;
    rolloutPercentage: number;
    isActive: boolean;
  }> = [];

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(async () => {
    await allowAuditWrites();
    // `feature_flags` is not in resetState's TRUNCATE list.
    for (const flag of flagsSnapshot) {
      await db().client.featureFlag.update({
        where: { key: flag.key },
        data: {
          status: flag.status as 'ON' | 'OFF' | 'PARTIAL',
          rolloutPercentage: flag.rolloutPercentage,
          isActive: flag.isActive,
        },
      });
    }
    flagsSnapshot = [];
    await resetState();
  });

  async function loginStaff(phone: string, role: string): Promise<Staff> {
    const email = `${role}-${phone.slice(-4)}@remediation.test`;
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, role);
    await db().client.user.update({
      where: { id: seed.userId },
      data: { email, passwordHash: hashPassword(PASSWORD), isEmailVerified: true },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return {
      userId: seed.userId,
      headers: {
        authorization: `Bearer ${loggedIn.json().accessToken}`,
        'user-agent': USER_AGENT,
      },
    };
  }

  function as(staff: Staff, request: InjectOptions) {
    return app.inject({ ...request, headers: { ...staff.headers, ...request.headers } });
  }

  function assertActor(
    row: { actorId: string | null; ipAddress: string | null; userAgent: string | null },
    staff: Staff,
  ) {
    assert.equal(row.actorId, staff.userId, 'the authenticated caller, never a body field');
    assert.notEqual(row.actorId, SPOOFED_ACTOR_ID);
    assert.equal(row.ipAddress, '127.0.0.1');
    assert.equal(row.userAgent, USER_AGENT);
  }

  const auditCount = () => db().client.adminActivityLog.count();

  async function snapshotFlags(admin: Staff) {
    // The GET seeds the flag catalog on first use.
    await as(admin, { method: 'GET', url: '/api/v1/admin/settings/feature-flags' });
    flagsSnapshot = await db().client.featureFlag.findMany({
      select: { key: true, status: true, rolloutPercentage: true, isActive: true },
    });
  }
  const flag = (key: string) => db().client.featureFlag.findUniqueOrThrow({ where: { key } });
  const updateFlags = (flags: Array<Record<string, unknown>>): InjectOptions => ({
    method: 'PUT',
    url: '/api/v1/admin/settings/feature-flags',
    payload: { flags, actorId: SPOOFED_ACTOR_ID },
  });

  // ───────────────────────────────────────────── V1. auth-otp job payloads ──
  describe('V1 the job browser never exposes an OTP or the phone it was sent to', () => {
    const OTP_CODE = '739184';
    const OTP_PHONE = '+919811177733';
    const LEAKS = [new RegExp(OTP_CODE), /9811177733/, /98111\D{0,3}77733/];
    const DTO_KEYS = [
      'attemptsMade',
      'data',
      'failedReason',
      'finishedOn',
      'id',
      'maxAttempts',
      'name',
      'processedOn',
      'queue',
      'status',
      'timestamp',
    ];
    let worker: Worker | undefined;

    afterEach(async () => {
      await worker?.close(true);
      worker = undefined;
    });

    function assertNoOtpSecrets(body: unknown, leaks: RegExp[] = LEAKS) {
      for (const leaf of everyLeaf(body)) {
        for (const leak of leaks) assert.doesNotMatch(leaf, leak, `leaked: ${leaf}`);
      }
      for (const key of [
        'code',
        'phoneNumber',
        'challengeId',
        'purpose',
        'returnvalue',
        'stacktrace',
      ]) {
        assert.ok(!everyLeaf(body).includes(key), `payload field "${key}" in the response`);
      }
    }

    /// One real auth-otp job in each state, every one carrying the code and the phone.
    async function seedOtpJobs() {
      const queue = otpQueue();
      await queue.drain(true); // staff logins queued their own codes
      const data = (challengeId: string) => ({
        challengeId,
        phoneNumber: OTP_PHONE,
        code: OTP_CODE,
        purpose: 'LOGIN' as const,
      });
      const ids = {
        failed: randomUUID(),
        completed: randomUUID(),
        active: randomUUID(),
        waiting: randomUUID(),
        delayed: randomUUID(),
      };
      // Manual processing, so each job is put in its state deterministically.
      worker = new Worker(QUEUE_NAMES.AUTH_OTP, null, {
        connection: createQueueConnection(),
        autorun: false,
      });
      const token = randomUUID();

      await queue.add(JOB_NAMES.OTP_SEND, data(ids.failed), { jobId: ids.failed, attempts: 1 });
      const failing = await worker.getNextJob(token);
      assert.equal(failing?.id, ids.failed);
      // The way a provider error reads: it echoes the recipient and the message.
      await failing.moveToFailed(
        new Error(`Airtel rejected SMS to ${OTP_PHONE}: "Your code is ${OTP_CODE}"`),
        token,
        false,
      );

      await queue.add(JOB_NAMES.OTP_SEND, data(ids.completed), {
        jobId: ids.completed,
        removeOnComplete: false,
      });
      const completing = await worker.getNextJob(token);
      assert.equal(completing?.id, ids.completed);
      await completing.moveToCompleted(
        { delivered: true, provider: 'airtel', echo: `${OTP_PHONE}:${OTP_CODE}` },
        token,
        false,
      );

      await queue.add(JOB_NAMES.OTP_SEND, data(ids.active), { jobId: ids.active });
      const active = await worker.getNextJob(token);
      assert.equal(active?.id, ids.active);

      // The production producer, exactly as /auth/otp/send enqueues.
      await enqueueOtpDelivery(data(ids.waiting));
      await queue.add(JOB_NAMES.OTP_SEND, data(ids.delayed), {
        jobId: ids.delayed,
        delay: 60 * 60 * 1000,
      });

      for (const [state, id] of Object.entries(ids)) {
        const job = await queue.getJob(id);
        assert.equal(await job?.getState(), state, `seeded ${state}`);
        assert.equal(job?.data.code, OTP_CODE, 'the job really carries the code');
      }
      return ids;
    }

    it('403 for a staff role without jobs:read — list, detail and counts', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const ids = await seedOtpJobs();
      for (const url of [
        '/api/v1/admin/jobs/queues',
        '/api/v1/admin/jobs/queues/auth-otp/jobs?status=waiting',
        `/api/v1/admin/jobs/auth-otp/${ids.waiting}`,
      ]) {
        const res = await as(support, { method: 'GET', url });
        assert.equal(res.statusCode, 403, `${url}: ${res.payload}`);
        assert.equal(res.json().error.code, 'FORBIDDEN');
        for (const leaf of everyLeaf(res.json())) {
          for (const leak of LEAKS) assert.doesNotMatch(leaf, leak);
        }
      }
    });

    it('list and detail show state and attempts in every state, never the code or phone', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const ids = await seedOtpJobs();

      for (const [status, id] of Object.entries(ids)) {
        const list = await as(admin, {
          method: 'GET',
          url: `/api/v1/admin/jobs/queues/auth-otp/jobs?status=${status}&limit=100`,
        });
        assert.equal(list.statusCode, 200, list.payload);
        assertNoOtpSecrets(list.json());
        const listed = (list.json().data as Array<Record<string, unknown>>).find(
          (j) => j.id === id,
        );
        assert.ok(listed, `${status} job is listed`);
        assert.equal(listed.status, status);
        assert.equal(listed.queue, 'auth-otp');
        assert.equal(listed.name, JOB_NAMES.OTP_SEND);
        assert.equal(listed.data, null, 'no payload field of an auth-otp job is shown');
        assert.equal(typeof listed.attemptsMade, 'number');

        const detail = await as(admin, { method: 'GET', url: `/api/v1/admin/jobs/auth-otp/${id}` });
        assert.equal(detail.statusCode, 200, detail.payload);
        assertNoOtpSecrets(detail.json());
        const dto = detail.json().data as Record<string, unknown>;
        assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS, 'only the DTO, nothing of the job');
        assert.equal(dto.status, status);
        assert.equal(dto.data, null);
      }

      const failed = (
        await as(admin, { method: 'GET', url: `/api/v1/admin/jobs/auth-otp/${ids.failed}` })
      ).json().data as Record<string, unknown>;
      assert.equal(failed.maxAttempts, 1);
      assert.equal(failed.attemptsMade, 1);
      assert.match(
        String(failed.failedReason),
        /^Airtel rejected SMS to \[number\]/,
        'kept, redacted',
      );

      const queues = await as(admin, { method: 'GET', url: '/api/v1/admin/jobs/queues' });
      assert.equal(queues.statusCode, 200);
      assertNoOtpSecrets(queues.json());
      const otp = (queues.json().data as Array<Record<string, unknown>>).find(
        (q) => q.name === 'auth-otp',
      );
      assert.deepEqual(
        { ...otp },
        { name: 'auth-otp', waiting: 1, active: 1, delayed: 1, failed: 1, completed: 1 },
      );
    });

    it('a code sent through the real /auth/otp/send flow stays out of the browser', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const sent = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/send',
        payload: { phoneNumber: OTP_PHONE },
      });
      assert.equal(sent.statusCode, 200, sent.payload);
      const challengeId = sent.json().challengeId as string;
      const job = await otpQueue().getJob(challengeId);
      assert.equal(job?.data.code, FIXED_OTP, 'the queued job carries the plaintext code');

      const leaks = [new RegExp(FIXED_OTP), /9811177733/];
      const list = await as(admin, {
        method: 'GET',
        url: '/api/v1/admin/jobs/queues/auth-otp/jobs?status=waiting&limit=100',
      });
      assert.equal(list.statusCode, 200, list.payload);
      assert.ok((list.json().data as Array<{ id: string }>).some((j) => j.id === challengeId));
      assertNoOtpSecrets(list.json(), leaks);
      const detail = await as(admin, {
        method: 'GET',
        url: `/api/v1/admin/jobs/auth-otp/${challengeId}`,
      });
      assert.equal(detail.statusCode, 200, detail.payload);
      assertNoOtpSecrets(detail.json(), leaks);
    });

    it('removing an auth-otp job is audited without its payload', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const ids = await seedOtpJobs();
      const res = await as(admin, {
        method: 'POST',
        url: `/api/v1/admin/jobs/auth-otp/${ids.waiting}`,
        payload: { action: 'remove', actorId: SPOOFED_ACTOR_ID },
      });
      assert.equal(res.statusCode, 204, res.payload);
      const rows = await auditRows('background_job');
      assert.deepEqual(results(rows), ['REQUESTED', 'SUCCESS']);
      for (const row of rows) assertActor(row, admin);
      assertNoOtpSecrets(rows.map((r) => r.metadata));
    });
  });

  // ───────────────────────────────── V4. force logout after-commit semantics ──
  describe('V4 force logout: a cache failure after commit is not a rollback', () => {
    const epochs = () => container.resolve<EpochService>('epochService');
    const forceLogout = (userId: string): InjectOptions => ({
      method: 'POST',
      url: '/api/v1/admin/security/force-logout-all',
      payload: { userId, actorId: SPOOFED_ACTOR_ID },
    });
    const activeSessions = (userId: string) =>
      db().client.userSession.count({ where: { userId, revokedAt: null } });
    const activeTokens = (userId: string) =>
      db().client.refreshToken.count({ where: { userId, revokedAt: null } });
    const activeAdminSessions = (userId: string) =>
      db().client.adminSession.count({ where: { userId, revokedAt: null } });
    const revokedEvents = (userId: string) =>
      db().client.outboxEvent.count({
        where: { eventType: 'account.sessions.force_revoked', aggregateId: userId },
      });
    const me = (staff: Staff) =>
      app.inject({ method: 'GET', url: '/api/v1/users/me', headers: staff.headers });

    /// Makes the Nth epoch bump for `userId` throw, the way an unreachable Redis would.
    /// The first bump runs inside the transaction; the second after commit.
    function failBump(userId: string, nth: 1 | 2) {
      const service = epochs();
      const original = service.bump.bind(service);
      let calls = 0;
      service.bump = async (id: string) => {
        if (id === userId && ++calls === nth) throw new Error('Redis unavailable (test)');
        return original(id);
      };
      return () => {
        delete (service as { bump?: unknown }).bump; // back to the prototype method
      };
    }

    it('the post-commit bump fails: revoked and audited, reported PENDING, reconciled by the outbox', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const sessions = await activeSessions(target.userId);
      assert.ok(sessions >= 1);
      const epochBefore = await epochs().current(target.userId);

      const restore = failBump(target.userId, 2);
      let res;
      try {
        res = await as(admin, forceLogout(target.userId));
      } finally {
        restore();
      }

      assert.equal(
        res.statusCode,
        200,
        `the committed logout is not reported as failed: ${res.payload}`,
      );
      assert.deepEqual(res.json(), {
        revokedCount: 1,
        accountsLoggedOut: 1,
        cacheInvalidation: 'PENDING',
        cacheInvalidationPending: [target.userId],
      });
      // The database revocation stands.
      assert.equal(await activeSessions(target.userId), 0);
      assert.equal(await activeTokens(target.userId), 0);
      assert.equal(await activeAdminSessions(target.userId), 0);
      const rows = await auditRows('staff_user', target.userId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'LOGOUT');
      assert.equal(meta(rows[0]!).result, 'SUCCESS');
      assertActor(rows[0]!, admin);
      assert.equal(await revokedEvents(target.userId), 1, 'the reconciliation event committed');
      assert.equal(
        await epochs().current(target.userId),
        epochBefore + 1,
        'only the in-transaction bump',
      );
      assert.equal((await me(target)).statusCode, 401);

      // Reconciliation: relaying the committed event bumps the epoch the request could not.
      const off = bootEventConsumers();
      try {
        await drainOutbox();
      } finally {
        off();
      }
      assert.equal(await epochs().current(target.userId), epochBefore + 2);
      assert.equal((await me(target)).statusCode, 401);
      assert.equal((await auditRows('staff_user', target.userId)).length, 1, 'no second audit row');
    });

    it('the in-transaction bump fails: nothing is revoked, logged or published, and the request fails', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const sessions = await activeSessions(target.userId);
      const epochBefore = await epochs().current(target.userId);

      const restore = failBump(target.userId, 1);
      let res;
      try {
        res = await as(admin, forceLogout(target.userId));
      } finally {
        restore();
      }

      assert.equal(res.statusCode, 500, res.payload);
      assert.equal(await activeSessions(target.userId), sessions);
      assert.ok((await activeTokens(target.userId)) >= 1);
      assert.equal((await auditRows('staff_user')).length, 0);
      assert.equal(await revokedEvents(target.userId), 0);
      assert.equal(await epochs().current(target.userId), epochBefore);
      assert.equal((await me(target)).statusCode, 200);
    });
  });

  // ─────────────────────────────────────── V6 / phase 13. driver decisions ──
  describe('V6 + driver verification: approve, reject and resubmission are distinct, audited decisions', () => {
    async function seedPendingDriver(phone = SUBJECT_PHONE) {
      const user = await loginAs(app, phone);
      await grantRole(user.userId, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      await db().client.driver.update({
        where: { id: driverId },
        data: { verificationStatus: 'PENDING', rejectionReason: null },
      });
      await db().client.driverDocument.updateMany({
        where: { driverId },
        data: { verificationStatus: 'VERIFIED' },
      });
      return driverId;
    }
    const driver = (id: string) => db().client.driver.findUniqueOrThrow({ where: { id } });
    const verify = (driverId: string, payload: Record<string, unknown>): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      payload: { ...payload, actorId: SPOOFED_ACTOR_ID },
    });
    const resubmit = (driverId: string, notes?: string): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/applications/${driverId}/request-resubmission`,
      payload: { ...(notes ? { notes } : {}), actorId: SPOOFED_ACTOR_ID },
    });

    it('403: support can neither verify nor request resubmission', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const driverId = await seedPendingDriver();
      assert.equal((await as(support, verify(driverId, { status: 'VERIFIED' }))).statusCode, 403);
      assert.equal((await as(support, resubmit(driverId, 'Fix it'))).statusCode, 403);
      assert.equal((await driver(driverId)).verificationStatus, 'PENDING');
      assert.equal(await auditCount(), 0);
    });

    it('a resubmission request is recorded as itself — never as REJECT — with the instructions', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      const res = await as(admin, resubmit(driverId, 'Upload a sharper licence photo'));
      assert.equal(res.statusCode, 200, res.payload);
      const row = await driver(driverId);
      assert.equal(row.verificationStatus, 'REJECTED');
      assert.equal(row.rejectionReason, 'Upload a sharper licence photo');

      const rows = await auditRows('driver', driverId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'UPDATE');
      assert.notEqual(rows[0]!.action, 'REJECT');
      assert.equal(rows[0]!.summary, 'Driver Resubmission Requested');
      assertActor(rows[0]!, admin);
      assert.deepEqual(meta(rows[0]!).before, {
        verificationStatus: 'PENDING',
        rejectionReason: null,
      });
      assert.deepEqual(meta(rows[0]!).after, {
        verificationStatus: 'REJECTED',
        rejectionReason: 'Upload a sharper licence photo',
        decision: 'RESUBMISSION_REQUESTED',
      });
      assert.equal(meta(rows[0]!).notes, 'Upload a sharper licence photo');
      assert.equal(meta(rows[0]!).result, 'SUCCESS');
    });

    it('from REJECTED, new instructions are a real change; the same ones again are a 409 no-op', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      const rejected = await as(
        admin,
        verify(driverId, { status: 'REJECTED', rejectionReason: 'Blurred licence' }),
      );
      assert.equal(rejected.statusCode, 200, rejected.payload);

      const first = await as(admin, resubmit(driverId, 'Retake the licence photo in daylight'));
      assert.equal(first.statusCode, 200, `the operator's action is recorded: ${first.payload}`);
      const again = await as(admin, resubmit(driverId, 'Retake the licence photo in daylight'));
      assert.equal(again.statusCode, 409, again.payload);

      const rows = await auditRows('driver', driverId);
      assert.deepEqual(
        rows.map((r) => [r.action, r.summary]),
        [
          ['REJECT', 'Driver Verification Rejected'],
          ['UPDATE', 'Driver Resubmission Requested'],
        ],
      );
      assert.equal(meta(rows[1]!).before?.rejectionReason, 'Blurred licence');
      assert.equal(meta(rows[1]!).notes, 'Retake the licence photo in daylight');
      assert.equal(
        (await driver(driverId)).rejectionReason,
        'Retake the licence photo in daylight',
      );
    });

    it('a SUSPENDED driver cannot be sent back: 409, nothing changes or is logged', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      await db().client.driver.update({
        where: { id: driverId },
        data: { verificationStatus: 'SUSPENDED' },
      });
      const res = await as(admin, resubmit(driverId, 'Fix it'));
      assert.equal(res.statusCode, 409, res.payload);
      assert.equal((await driver(driverId)).verificationStatus, 'SUSPENDED');
      assert.equal(await auditCount(), 0);
    });

    it('concurrent identical resubmissions: one change and one row, the other refused', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      const res = await Promise.all([
        as(admin, resubmit(driverId, 'Same instructions')),
        as(admin, resubmit(driverId, 'Same instructions')),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode).sort(),
        [200, 409],
        res.map((r) => r.payload).join('\n'),
      );
      assert.equal((await auditRows('driver', driverId)).length, 1);
    });

    it('a failed audit write rolls the resubmission back', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      await refuseAuditWrites('driver');
      const res = await as(admin, resubmit(driverId, 'Fix it'));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      const row = await driver(driverId);
      assert.equal(row.verificationStatus, 'PENDING');
      assert.equal(row.rejectionReason, null);
      assert.equal(await auditCount(), 0);
    });

    it('approve then reject: an APPROVE and a REJECT row whose before/after chain', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      assert.equal((await as(admin, verify(driverId, { status: 'VERIFIED' }))).statusCode, 200);
      const rej = await as(
        admin,
        verify(driverId, { status: 'REJECTED', rejectionReason: 'Fraud check' }),
      );
      assert.equal(rej.statusCode, 200, rej.payload);
      const rows = await auditRows('driver', driverId);
      assert.deepEqual(
        rows.map((r) => r.action),
        ['APPROVE', 'REJECT'],
      );
      for (const row of rows) assertActor(row, admin);
      assert.equal(meta(rows[0]!).before?.verificationStatus, 'PENDING');
      assert.equal(meta(rows[0]!).after?.verificationStatus, 'VERIFIED');
      assert.equal(meta(rows[1]!).before?.verificationStatus, 'VERIFIED');
      assert.equal(meta(rows[1]!).after?.verificationStatus, 'REJECTED');
      assert.equal(meta(rows[1]!).notes, 'Fraud check');
    });

    it('a failed audit write rolls a rejection back', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      await refuseAuditWrites('driver');
      const res = await as(admin, verify(driverId, { status: 'REJECTED', rejectionReason: 'x' }));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal((await driver(driverId)).verificationStatus, 'PENDING');
      assert.equal(await auditCount(), 0);
    });

    it('concurrent approve, reject and resubmission serialise: the trail chains to the final state', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const other = await loginStaff(OTHER_ADMIN_PHONE, 'system_admin');
      const driverId = await seedPendingDriver();
      const res = await Promise.all([
        as(admin, verify(driverId, { status: 'VERIFIED' })),
        as(other, verify(driverId, { status: 'REJECTED', rejectionReason: 'Mismatch' })),
        as(admin, resubmit(driverId, 'Re-upload the RC')),
      ]);
      for (const r of res) assert.ok(r.statusCode === 200 || r.statusCode === 409, r.payload);
      const rows = await auditRows('driver', driverId);
      // A decision that finds the driver already in its target state is a 200 no-op with
      // no row, so there are at most as many rows as 200s — and at least the first.
      const ok = res.filter((r) => r.statusCode === 200).length;
      assert.ok(rows.length >= 1 && rows.length <= ok, `${rows.length} rows for ${ok} successes`);
      // Each decision's `before` is the state the previous one left.
      let state = 'PENDING';
      for (const row of rows) {
        assert.equal(meta(row).before?.verificationStatus, state);
        state = String(meta(row).after?.verificationStatus);
      }
      assert.equal((await driver(driverId)).verificationStatus, state);
    });

    it('an admin cannot decide on their own driver application', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const driverId = await makeDriver(admin.userId, { verified: true });
      await db().client.driver.update({
        where: { id: driverId },
        data: { verificationStatus: 'PENDING' },
      });
      for (const req of [verify(driverId, { status: 'VERIFIED' }), resubmit(driverId, 'x')]) {
        const res = await as(admin, req);
        assert.ok(res.statusCode >= 400 && res.statusCode < 500, res.payload);
      }
      assert.equal((await driver(driverId)).verificationStatus, 'PENDING');
      assert.equal(await auditCount(), 0);
    });
  });

  // ─────────────────────────────────────────── phase 12. document review ──
  describe('document review: every route that reviews a driver document', () => {
    const SECRET_NUMBER = 'DL-SECRET-7781';
    const ROUTES = [
      {
        name: 'POST /admin/drivers/:driverId/documents/:documentId/review',
        url: (driverId: string, docId: string) =>
          `/api/v1/admin/drivers/${driverId}/documents/${docId}/review`,
      },
      {
        name: 'POST /admin/applications/:id/documents/:documentId/review',
        url: (driverId: string, docId: string) =>
          `/api/v1/admin/applications/${driverId}/documents/${docId}/review`,
      },
      {
        name: 'POST /admin/documents/:documentId/review',
        url: (_driverId: string, docId: string) => `/api/v1/admin/documents/${docId}/review`,
      },
    ];

    async function seedPendingDocs(phone = SUBJECT_PHONE) {
      const user = await loginAs(app, phone);
      await grantRole(user.userId, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      await db().client.driver.update({
        where: { id: driverId },
        data: { verificationStatus: 'PENDING' },
      });
      await db().client.driverDocument.updateMany({
        where: { driverId },
        data: {
          verificationStatus: 'PENDING',
          documentNumber: SECRET_NUMBER,
          verifiedAt: null,
          verifiedBy: null,
        },
      });
      const docs = await db().client.driverDocument.findMany({ where: { driverId } });
      return { driverId, docId: docs[0]!.id };
    }
    const doc = (id: string) => db().client.driverDocument.findUniqueOrThrow({ where: { id } });
    function assertNoDocumentSecrets(rows: Array<{ metadata: unknown }>) {
      const text = JSON.stringify(rows.map((r) => r.metadata));
      assert.doesNotMatch(text, new RegExp(SECRET_NUMBER), 'no document number');
      assert.doesNotMatch(text, /example\.invalid|fileUrl|fileId|storageKey/, 'no file location');
    }

    for (const route of ROUTES) {
      describe(route.name, () => {
        const review = (driverId: string, docId: string, payload: Record<string, unknown>) => ({
          method: 'POST' as const,
          url: route.url(driverId, docId),
          payload: { ...payload, actorId: SPOOFED_ACTOR_ID },
        });

        it('403 for support: unchanged, nothing logged', async () => {
          const support = await loginStaff(SUPPORT_PHONE, 'support');
          const { driverId, docId } = await seedPendingDocs();
          const res = await as(support, review(driverId, docId, { status: 'VERIFIED' }));
          assert.equal(res.statusCode, 403, res.payload);
          assert.equal((await doc(docId)).verificationStatus, 'PENDING');
          assert.equal(await auditCount(), 0);
        });

        it('VERIFIED: one APPROVE row with before/after and the JWT actor, no document secrets', async () => {
          const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
          const { driverId, docId } = await seedPendingDocs();
          const res = await as(admin, review(driverId, docId, { status: 'VERIFIED' }));
          assert.equal(res.statusCode, 200, res.payload);
          const reviewed = await doc(docId);
          assert.equal(reviewed.verificationStatus, 'VERIFIED');
          assert.equal(reviewed.verifiedBy, admin.userId);
          const rows = await auditRows('driver_document', docId);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.action, 'APPROVE');
          assertActor(rows[0]!, admin);
          assert.equal(meta(rows[0]!).before?.verificationStatus, 'PENDING');
          assert.equal(meta(rows[0]!).after?.verificationStatus, 'VERIFIED');
          assert.equal(meta(rows[0]!).result, 'SUCCESS');
          assertNoDocumentSecrets(rows);
        });

        it('REJECTED: one REJECT row carrying the reason', async () => {
          const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
          const { driverId, docId } = await seedPendingDocs();
          const res = await as(
            admin,
            review(driverId, docId, { status: 'REJECTED', rejectionReason: 'Photo is cropped' }),
          );
          assert.equal(res.statusCode, 200, res.payload);
          const rows = await auditRows('driver_document', docId);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.action, 'REJECT');
          assert.equal(meta(rows[0]!).notes, 'Photo is cropped');
          assertNoDocumentSecrets(rows);
        });

        it('a failed audit write rolls the review back', async () => {
          const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
          const { driverId, docId } = await seedPendingDocs();
          await refuseAuditWrites('driver_document');
          const res = await as(admin, review(driverId, docId, { status: 'VERIFIED' }));
          assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
          const unchanged = await doc(docId);
          assert.equal(unchanged.verificationStatus, 'PENDING');
          assert.equal(unchanged.verifiedBy, null);
          assert.equal(await auditCount(), 0);
        });

        it('concurrent and repeated identical reviews change and log once', async () => {
          const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
          const { driverId, docId } = await seedPendingDocs();
          const res = await Promise.all([
            as(admin, review(driverId, docId, { status: 'VERIFIED' })),
            as(admin, review(driverId, docId, { status: 'VERIFIED' })),
            as(admin, review(driverId, docId, { status: 'VERIFIED' })),
          ]);
          assert.deepEqual(
            res.map((r) => r.statusCode),
            [200, 200, 200],
          );
          assert.equal(
            (await as(admin, review(driverId, docId, { status: 'VERIFIED' }))).statusCode,
            200,
          );
          assert.equal((await auditRows('driver_document', docId)).length, 1);
        });

        it("an admin cannot review their own driver's documents", async () => {
          const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
          const driverId = await makeDriver(admin.userId, { verified: true });
          await db().client.driverDocument.updateMany({
            where: { driverId },
            data: { verificationStatus: 'PENDING' },
          });
          const docId = (await db().client.driverDocument.findFirstOrThrow({ where: { driverId } }))
            .id;
          const res = await as(admin, review(driverId, docId, { status: 'VERIFIED' }));
          assert.ok(res.statusCode >= 400 && res.statusCode < 500, res.payload);
          assert.equal((await doc(docId)).verificationStatus, 'PENDING');
          assert.equal(await auditCount(), 0);
        });
      });
    }

    it('the two routes naming a driver refuse a document that belongs to another driver', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const first = await seedPendingDocs(SUBJECT_PHONE);
      const second = await seedPendingDocs(OTHER_SUBJECT_PHONE);
      for (const route of ROUTES.slice(0, 2)) {
        const res = await as(admin, {
          method: 'POST',
          url: route.url(first.driverId, second.docId),
          payload: { status: 'VERIFIED' },
        });
        assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${route.name}: ${res.payload}`);
      }
      assert.equal((await doc(second.docId)).verificationStatus, 'PENDING');
      assert.equal(await auditCount(), 0);
    });

    it('returning a document to PENDING (compliance route) is logged as UPDATE, not REJECT', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId, docId } = await seedPendingDocs();
      const url = ROUTES[2]!.url(driverId, docId);
      assert.equal(
        (await as(admin, { method: 'POST', url, payload: { status: 'VERIFIED' } })).statusCode,
        200,
      );
      const res = await as(admin, { method: 'POST', url, payload: { status: 'PENDING' } });
      assert.equal(res.statusCode, 200, res.payload);
      const rows = await auditRows('driver_document', docId);
      assert.deepEqual(
        rows.map((r) => r.action),
        ['APPROVE', 'UPDATE'],
      );
      assert.match(String(rows[1]!.summary), /returned to pending/);
    });
  });

  // ────────────────────────────────────────────────── V7. alert acknowledge ──
  describe('V7 alert acknowledgement is claimed atomically', () => {
    const ack = (alertId: string, headers: Record<string, string> = {}): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/monitoring/alerts/${encodeURIComponent(alertId)}/ack`,
      headers,
      payload: { actorId: SPOOFED_ACTOR_ID },
    });
    const rowsFor = async (alertId: string) =>
      (await auditRows('monitoring_alert')).filter(
        (r) => r.summary === `Alert ${alertId} acknowledged`,
      );

    it('two admins at once: exactly one SUCCESS owns the alert, the other is refused 409', async () => {
      const a = await loginStaff(ADMIN_PHONE, 'system_admin');
      const b = await loginStaff(OTHER_ADMIN_PHONE, 'system_admin');
      for (let round = 0; round < 6; round++) {
        const alertId = `queue_backlog:remediation-${round}`;
        const [ra, rb] = await Promise.all([as(a, ack(alertId)), as(b, ack(alertId))]);
        const codes = [ra.statusCode, rb.statusCode].sort();
        assert.equal(codes[0]! < 300, true, `${ra.payload} ${rb.payload}`);
        assert.equal(codes[1], 409, `${ra.payload} ${rb.payload}`);
        const [winner, loser] = ra.statusCode < 300 ? [a, b] : [b, a];

        const owner = (await getAlertAcks()).get(alertId);
        assert.equal(owner?.actorId, winner.userId, 'Redis names the winner, never overwritten');

        const rows = await rowsFor(alertId);
        const success = rows.filter((r) => meta(r).result === 'SUCCESS');
        const noop = rows.filter((r) => meta(r).result === 'NO_OP');
        const requested = rows.filter((r) => meta(r).result === 'REQUESTED');
        assert.equal(success.length, 1, 'exactly one SUCCESS');
        assert.equal(success[0]!.actorId, winner.userId);
        for (const row of noop) assert.equal(row.actorId, loser.userId);
        assert.equal(
          requested.length,
          success.length + noop.length,
          'every request has one outcome',
        );
        assert.ok(
          rows.every((r) => ['SUCCESS', 'NO_OP', 'REQUESTED'].includes(String(meta(r).result))),
        );
      }
    });

    it('a later acknowledgement is refused 409, logs nothing, and leaves the owner as it was', async () => {
      const a = await loginStaff(ADMIN_PHONE, 'system_admin');
      const b = await loginStaff(OTHER_ADMIN_PHONE, 'system_admin');
      const alertId = 'queue_backlog:remediation-late';
      assert.ok((await as(a, ack(alertId))).statusCode < 300);
      const owned = (await getAlertAcks()).get(alertId);
      const late = await as(b, ack(alertId));
      assert.equal(late.statusCode, 409, late.payload);
      assert.deepEqual((await getAlertAcks()).get(alertId), owned);
      assert.deepEqual(results(await rowsFor(alertId)), ['REQUESTED', 'SUCCESS']);
    });

    it('V5: a spoofed X-Forwarded-For and header/body actor claims change neither the IP nor the actor', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const alertId = 'queue_backlog:remediation-spoof';
      const res = await as(
        admin,
        ack(alertId, {
          'x-forwarded-for': '198.51.100.23, 203.0.113.9',
          'x-real-ip': '198.51.100.23',
          'x-user-id': SPOOFED_ACTOR_ID,
          'x-actor-id': SPOOFED_ACTOR_ID,
        }),
      );
      assert.ok(res.statusCode < 300, res.payload);
      const rows = await rowsFor(alertId);
      assert.equal(rows.length, 2);
      for (const row of rows) assertActor(row, admin); // ipAddress is the socket peer, 127.0.0.1
      assert.equal((await getAlertAcks()).get(alertId)?.actorId, admin.userId);
    });
  });

  // ──────────────────────────────────────────── V8. push schedule idempotency ──
  describe('V8 push schedule: one Idempotency-Key, one broadcast', () => {
    const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const schedule = (key: string | undefined, title = 'Diwali offer'): InjectOptions => ({
      method: 'POST',
      url: '/api/v1/admin/communications/push/schedule',
      headers: key ? { 'idempotency-key': key } : {},
      payload: {
        title,
        body: 'Rides are 20% off tonight',
        targeting: { roles: ['customer'] },
        scheduledAt,
        actorId: SPOOFED_ACTOR_ID,
      },
    });
    const broadcasts = () => db().client.adminBroadcast.count();

    it('concurrent submissions with one key: one broadcast, one SUCCESS row, every caller gets it', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const key = randomUUID();
      const res = await Promise.all(Array.from({ length: 5 }, () => as(admin, schedule(key))));
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [201, 201, 201, 201, 201],
        res.map((r) => r.payload).join('\n'),
      );
      const ids = new Set(res.map((r) => r.json().data.id as string));
      assert.equal(ids.size, 1, 'every response names the same broadcast');
      assert.equal(await broadcasts(), 1);
      const [id] = [...ids];
      const rows = await auditRows('admin_broadcast');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.entityId, id);
      assert.equal(meta(rows[0]!).result, 'SUCCESS');
      assertActor(rows[0]!, admin);

      const retry = await as(admin, schedule(key));
      assert.equal(retry.statusCode, 201, retry.payload);
      assert.equal(retry.json().data.id, id, 'a retry returns the existing result');
      assert.equal(await broadcasts(), 1);
      assert.equal((await auditRows('admin_broadcast')).length, 1);
    });

    it('the same key for a different broadcast is refused 409 and creates nothing', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const key = randomUUID();
      assert.equal((await as(admin, schedule(key))).statusCode, 201);
      const reused = await as(admin, schedule(key, 'A different broadcast'));
      assert.equal(reused.statusCode, 409, reused.payload);
      assert.equal(await broadcasts(), 1);
      assert.equal((await auditRows('admin_broadcast')).length, 1);
    });

    it('keys are scoped to the operator', async () => {
      const a = await loginStaff(ADMIN_PHONE, 'system_admin');
      const b = await loginStaff(OTHER_ADMIN_PHONE, 'system_admin');
      const key = randomUUID();
      const [ra, rb] = await Promise.all([as(a, schedule(key)), as(b, schedule(key))]);
      assert.deepEqual([ra.statusCode, rb.statusCode], [201, 201]);
      assert.notEqual(ra.json().data.id, rb.json().data.id);
      assert.equal(await broadcasts(), 2);
    });

    it('a failed audit write leaves no broadcast, and the key stays usable', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const key = randomUUID();
      await refuseAuditWrites('admin_broadcast');
      assert.ok((await as(admin, schedule(key))).statusCode >= 500);
      assert.equal(await broadcasts(), 0);
      await allowAuditWrites();
      assert.equal((await as(admin, schedule(key))).statusCode, 201);
      assert.equal(await broadcasts(), 1);
    });
  });

  // ─────────────────────────────────────────────── V9. settings actor guard ──
  describe('V9 settings writers fail closed without an authenticated actor', () => {
    it('a feature-flag or map write reached with no actor changes nothing and logs nothing', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await snapshotFlags(admin);
      const surge = await flag('surge');
      const noActor = {} as AuditActor;

      const platform = container.resolve<AdminPlatformSettingsService>(
        'adminPlatformSettingsService',
      );
      await assert.rejects(
        platform.updateFeatureFlags(
          { flags: [{ key: 'surge', rolloutPercentage: (surge.rolloutPercentage + 7) % 100 }] },
          noActor,
        ),
        MissingAuditActorError,
      );
      assert.equal((await flag('surge')).rolloutPercentage, surge.rolloutPercentage);

      const maps = container.resolve<AdminMapSettingsService>('adminMapSettingsService');
      const settingsBefore = await db().client.systemSetting.findMany({
        where: { category: 'maps' },
      });
      await assert.rejects(
        maps.updateMapSettings({ primaryProvider: 'ola' } as Parameters<
          AdminMapSettingsService['updateMapSettings']
        >[0]),
        MissingAuditActorError,
      );
      assert.deepEqual(
        await db().client.systemSetting.findMany({ where: { category: 'maps' } }),
        settingsBefore,
      );
      assert.equal(await auditCount(), 0);
    });

    it('over HTTP a failed settings audit is a masked 500, not a 400 carrying the database text', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await snapshotFlags(admin);
      const surge = await flag('surge');
      await refuseAuditWrites('feature_flag');
      const res = await as(
        admin,
        updateFlags([{ key: 'surge', rolloutPercentage: (surge.rolloutPercentage + 9) % 100 }]),
      );
      assert.equal(res.statusCode, 500, res.payload);
      assert.doesNotMatch(res.payload, /audit write refused|admin_activity_logs|trigger/i);
      assert.equal((await flag('surge')).rolloutPercentage, surge.rolloutPercentage);
      assert.equal(await auditCount(), 0);
    });
  });

  // ─────────────────────────────────────────── V10. external error redaction ──
  describe('V10 a provider error never reaches audit metadata', () => {
    const PHONE = '+919811155566';
    const SECRETS = [
      /9811155566/,
      /482915/,
      /jane/i,
      /(^|[^a-z0-9.-])example\.com([^a-z0-9.-]|$)/i,
      /eyJ/,
      /mock_live/,
      /Jane Doe/,
    ];

    it('an SMS provider failure echoing recipient, code and token is logged FAILED with a code only', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const sms = container.resolve<AdminSmsSettingsService>('adminSmsSettingsService');
      sms.testSms = async () => {
        throw Object.assign(
          new Error(
            `Airtel 502 for ${PHONE} (Jane Doe, jane.doe@example.com): otp=482915 ` +
              'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig api_key=mock_live_51HxAbCdEfGhIjKlMnOp',
          ),
          { statusCode: 502 },
        );
      };
      let res;
      try {
        res = await as(admin, {
          method: 'POST',
          url: '/api/v1/admin/settings/integrations/sms/test',
          payload: { testPhone: PHONE },
        });
      } finally {
        delete (sms as { testSms?: unknown }).testSms;
      }
      assert.equal(res.statusCode, 500, res.payload);
      for (const secret of SECRETS) assert.doesNotMatch(res.payload, secret, 'not in the response');

      const rows = await auditRows('integration_test');
      assert.deepEqual(results(rows), ['REQUESTED', 'FAILED']);
      for (const row of rows) assertActor(row, admin);
      assert.deepEqual(meta(rows[1]!).after, {
        errorCode: 'HTTP_502',
        errorName: 'Error',
        reason: 'Upstream error (HTTP 502)',
      });
      assert.equal(meta(rows[0]!).before?.recipient, '***5566');
      const text = JSON.stringify(rows);
      for (const secret of SECRETS)
        assert.doesNotMatch(text, secret, `${secret} in audit metadata`);
    });

    it('a refused job action stores a code and a fixed reason, not the queue error text', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await otpQueue().drain(true);
      const challengeId = randomUUID();
      await enqueueOtpDelivery({
        challengeId,
        phoneNumber: PHONE,
        code: '482915',
        purpose: 'LOGIN',
      });
      // A waiting job has not failed, so BullMQ refuses to retry it.
      const res = await as(admin, {
        method: 'POST',
        url: `/api/v1/admin/jobs/auth-otp/${challengeId}`,
        payload: { action: 'retry' },
      });
      assert.ok(res.statusCode >= 400, res.payload);
      const rows = await auditRows('background_job');
      assert.deepEqual(results(rows), ['REQUESTED', 'FAILED']);
      const failed = meta(rows[1]!).after ?? {};
      assert.ok(typeof failed.errorCode === 'string' && typeof failed.reason === 'string');
      for (const key of Object.keys(failed)) {
        assert.ok(['errorCode', 'errorName', 'reason'].includes(key), `unexpected field ${key}`);
      }
      const text = JSON.stringify(rows);
      for (const secret of SECRETS) assert.doesNotMatch(text, secret);
    });
  });

  // ──────────────────────────────────────── phase 14. feature flag lock order ──
  describe('feature flags: overlapping batches in opposite order', () => {
    it('never deadlock, each finish, and the trail chains to the final state', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await snapshotFlags(admin);
      const original = {
        surge: (await flag('surge')).rolloutPercentage,
        driver_incentives: (await flag('driver_incentives')).rolloutPercentage,
      };
      const ROUNDS = 6;
      for (let round = 0; round < ROUNDS; round++) {
        // Distinct from each other and from every earlier value, so every write is a change.
        const a = 41 + round * 2;
        const b = 42 + round * 2;
        const res = await Promise.all([
          as(
            admin,
            updateFlags([
              { key: 'surge', rolloutPercentage: a },
              { key: 'driver_incentives', rolloutPercentage: a },
            ]),
          ),
          as(
            admin,
            updateFlags([
              { key: 'driver_incentives', rolloutPercentage: b },
              { key: 'surge', rolloutPercentage: b },
            ]),
          ),
        ]);
        assert.deepEqual(
          res.map((r) => r.statusCode),
          [200, 200],
          `round ${round}: ${res.map((r) => r.payload).join('\n')}`,
        );
        const surge = (await flag('surge')).rolloutPercentage;
        const incentives = (await flag('driver_incentives')).rolloutPercentage;
        assert.equal(surge, incentives, 'one batch committed after the other, whole');
        assert.ok([a, b].includes(surge));
      }

      const rows = await auditRows('feature_flag');
      assert.equal(rows.length, ROUNDS * 2 * 2, 'one row per flag per batch — each was a change');
      for (const row of rows) assertActor(row, admin);
      for (const key of ['surge', 'driver_incentives'] as const) {
        const id = (await flag(key)).id;
        const chain = rows.filter((r) => r.entityId === id);
        // Every value written was replaced by exactly the next write: a single path from the
        // original value to the final one, with no lost or duplicated update.
        const next = new Map(
          chain.map((r) => [meta(r).before?.rolloutPercentage, meta(r).after?.rolloutPercentage]),
        );
        assert.equal(next.size, chain.length, `${key}: no value was replaced twice`);
        let value: unknown = original[key];
        for (let i = 0; i < chain.length; i++) value = next.get(value);
        assert.equal(
          value,
          (await flag(key)).rolloutPercentage,
          `${key}: the chain ends at the final value`,
        );
      }
    });

    it('a batch that changes nothing writes nothing; naming a flag twice is refused', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await snapshotFlags(admin);
      const surge = await flag('surge');
      const same = await as(
        admin,
        updateFlags([
          { key: 'surge', rolloutPercentage: surge.rolloutPercentage, status: surge.status },
        ]),
      );
      assert.equal(same.statusCode, 200, same.payload);
      // (`updatedAt` is not compared: `ensureSeeded` refreshes every flag's catalog name on
      // each call. The values are what the operator controls.)
      const after_ = await flag('surge');
      assert.equal(after_.rolloutPercentage, surge.rolloutPercentage);
      assert.equal(after_.status, surge.status);
      assert.equal(await auditCount(), 0);

      const twice = await as(
        admin,
        updateFlags([
          { key: 'surge', rolloutPercentage: 1 },
          { key: 'surge', rolloutPercentage: 2 },
        ]),
      );
      assert.equal(twice.statusCode, 400, twice.payload);
      assert.equal((await flag('surge')).rolloutPercentage, surge.rolloutPercentage);
      assert.equal(await auditCount(), 0);
    });
  });

  // ───────────────────────────────────── phase 15. append-only in PostgreSQL ──
  describe('append-only audit tables, enforced by PostgreSQL', () => {
    const RUNTIME = 'zaroorat_app_runtime';

    async function seedRows() {
      const user = await db().client.user.create({ data: { phoneNumber: '+919876549090' } });
      const log = await db().client.adminActivityLog.create({
        data: { actorId: user.id, action: 'UPDATE', entityType: 'probe', summary: 'original' },
      });
      const change = await db().client.auditFieldChange.create({
        data: { activityLogId: log.id, fieldName: 'status', oldValue: 'A', newValue: 'B' },
      });
      return { user, log, change };
    }

    /// Runs `sql` in its own transaction — as the runtime role when asked — and returns the
    /// error PostgreSQL raised, or null.
    async function attempt(sql: string, role?: string): Promise<string | null> {
      try {
        await db().client.$transaction(async (tx) => {
          if (role) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await tx.$executeRawUnsafe(sql);
        });
        return null;
      } catch (err) {
        return String((err as Error).message);
      }
    }

    it('the migration chain creates every trigger, ENABLE ALWAYS, and the RESTRICT actor key', async () => {
      const applied = await db().client.$queryRawUnsafe<Array<{ migration_name: string }>>(
        `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
           AND migration_name IN ('20261001120000_admin_audit_append_only', '20261002130100_admin_audit_truncate_guard_runtime_role')`,
      );
      assert.equal(applied.length, 2, 'both migrations applied through the normal chain');

      const triggers = await db().client.$queryRawUnsafe<
        Array<{ tbl: string; tgname: string; tgenabled: string }>
      >(
        `SELECT tgrelid::regclass::text AS tbl, tgname, tgenabled::text AS tgenabled FROM pg_trigger
          WHERE tgrelid IN ('admin_activity_logs'::regclass, 'audit_field_changes'::regclass)
            AND NOT tgisinternal AND tgname NOT LIKE 'test_%' ORDER BY 1, 2`,
      );
      assert.deepEqual(triggers, [
        { tbl: 'admin_activity_logs', tgname: 'admin_activity_logs_append_only', tgenabled: 'A' },
        { tbl: 'admin_activity_logs', tgname: 'admin_activity_logs_no_truncate', tgenabled: 'A' },
        { tbl: 'audit_field_changes', tgname: 'audit_field_changes_append_only', tgenabled: 'A' },
        { tbl: 'audit_field_changes', tgname: 'audit_field_changes_no_truncate', tgenabled: 'A' },
      ]);

      const fk = await db().client.$queryRawUnsafe<Array<{ del: string; upd: string }>>(
        `SELECT confdeltype::text AS del, confupdtype::text AS upd FROM pg_constraint
          WHERE conname = 'admin_activity_logs_actor_id_fkey'`,
      );
      assert.deepEqual(fk, [{ del: 'r', upd: 'r' }], 'ON DELETE RESTRICT ON UPDATE RESTRICT');

      const migrations = path.resolve(process.cwd(), 'prisma/migrations');
      const first = readFileSync(
        path.join(migrations, '20261001120000_admin_audit_append_only/migration.sql'),
        'utf8',
      );
      const second = readFileSync(
        path.join(
          migrations,
          '20261002130100_admin_audit_truncate_guard_runtime_role/migration.sql',
        ),
        'utf8',
      );
      assert.match(
        first,
        /CREATE TRIGGER admin_activity_logs_append_only\s+BEFORE UPDATE OR DELETE/,
      );
      assert.match(
        first,
        /CREATE TRIGGER audit_field_changes_append_only\s+BEFORE UPDATE OR DELETE/,
      );
      assert.match(first, /ON DELETE RESTRICT ON UPDATE RESTRICT/);
      assert.match(second, /CREATE TRIGGER admin_activity_logs_no_truncate\s+BEFORE TRUNCATE/);
      assert.match(second, /CREATE TRIGGER audit_field_changes_no_truncate\s+BEFORE TRUNCATE/);
      assert.match(
        second,
        /REVOKE UPDATE, DELETE, TRUNCATE ON "admin_activity_logs", "audit_field_changes"/,
      );
    });

    for (const table of ['admin_activity_logs', 'audit_field_changes'] as const) {
      it(`${table}: INSERT allowed; UPDATE, DELETE and TRUNCATE refused, even for the owner`, async () => {
        const { log, change } = await seedRows();
        const id = table === 'admin_activity_logs' ? log.id : change.id;
        const column = table === 'admin_activity_logs' ? 'summary' : 'new_value';

        assert.match(
          String(await attempt(`UPDATE ${table} SET ${column} = 'x' WHERE id = '${id}'::uuid`)),
          /append-only: UPDATE refused/,
        );
        assert.match(
          String(await attempt(`DELETE FROM ${table} WHERE id = '${id}'::uuid`)),
          /append-only: DELETE refused/,
        );
        assert.match(
          String(await attempt(`TRUNCATE ${table} CASCADE`)),
          /append-only: TRUNCATE refused/,
        );
        // Reaching it through the actor foreign key is refused too.
        assert.match(
          String(await attempt('TRUNCATE users CASCADE')),
          /append-only: TRUNCATE refused/,
        );
        // The replica-mode switch that silences ordinary triggers does not silence these.
        assert.match(
          String(
            await db()
              .client.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
                await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = '${id}'::uuid`);
              })
              .then(
                () => null,
                (e: Error) => e.message,
              ),
          ),
          /append-only: DELETE refused/,
        );

        assert.equal(await db().client.adminActivityLog.count({ where: { id: log.id } }), 1);
        const kept = await db().client.auditFieldChange.findUniqueOrThrow({
          where: { id: change.id },
        });
        assert.equal(kept.newValue, 'B');
      });

      it(`${table}: the runtime role may INSERT but cannot UPDATE, DELETE, TRUNCATE, ALTER or DROP`, async () => {
        const { user, log, change } = await seedRows();
        const id = table === 'admin_activity_logs' ? log.id : change.id;
        const insert =
          table === 'admin_activity_logs'
            ? `INSERT INTO admin_activity_logs (id, actor_id, action, entity_type) VALUES (gen_random_uuid(), '${user.id}'::uuid, 'UPDATE', 'probe')`
            : `INSERT INTO audit_field_changes (id, activity_log_id, field_name) VALUES (gen_random_uuid(), '${log.id}'::uuid, 'probe')`;
        assert.equal(await attempt(insert, RUNTIME), null, 'INSERT allowed');

        for (const sql of [
          `UPDATE ${table} SET id = id WHERE id = '${id}'::uuid`,
          `DELETE FROM ${table} WHERE id = '${id}'::uuid`,
          `TRUNCATE ${table}`,
          'TRUNCATE users CASCADE',
          'SET session_replication_role = replica',
        ]) {
          assert.match(String(await attempt(sql, RUNTIME)), /permission denied/, sql);
        }
        for (const sql of [
          `ALTER TABLE ${table} DISABLE TRIGGER ALL`,
          `DROP TRIGGER ${table}_append_only ON ${table}`,
          `DROP TABLE ${table}`,
        ]) {
          assert.match(String(await attempt(sql, RUNTIME)), /must be owner/, sql);
        }
        assert.equal(
          await db().client.adminActivityLog.count({ where: { id: log.id } }),
          1,
          'the row survived every attempt',
        );
      });
    }

    it('staging and production refuse to boot as a role that can rewrite the audit trail', async () => {
      // This suite connects as the owner, a superuser: exactly the misconfiguration.
      const rights = await auditTrailRewriteRights(db().client);
      assert.ok(
        rights.some((r) => /superuser/.test(r)),
        rights.join('; '),
      );
      assert.ok(
        rights.some((r) => /owns the audit tables/.test(r)),
        rights.join('; '),
      );
      assert.ok(
        rights.some((r) => /UPDATE, DELETE or TRUNCATE/.test(r)),
        rights.join('; '),
      );
      for (const environment of ['production', 'staging']) {
        await assert.rejects(
          assertRestrictedDatabaseRole(db().client, environment),
          new RegExp(
            `Refusing to start in ${environment}: DATABASE_URL connects as a role that can rewrite`,
          ),
        );
      }
      // Development and test connect as the owner on purpose.
      await assertRestrictedDatabaseRole(db().client, 'development');
      await assertRestrictedDatabaseRole(db().client, 'test');

      // The restricted runtime role boots in production.
      const asRuntime = await db().client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RUNTIME}`);
        await assertRestrictedDatabaseRole(tx, 'production');
        return auditTrailRewriteRights(tx);
      });
      assert.deepEqual(asRuntime, []);
    });

    it('the runtime role is no superuser, owns nothing, holds no TRUNCATE, and can run the app', async () => {
      const [role] = await db().client.$queryRawUnsafe<
        Array<{
          rolsuper: boolean;
          rolcanlogin: boolean;
          rolbypassrls: boolean;
          rolcreaterole: boolean;
        }>
      >(
        `SELECT rolsuper, rolcanlogin, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = '${RUNTIME}'`,
      );
      assert.deepEqual(role, {
        rolsuper: false,
        rolcanlogin: false,
        rolbypassrls: false,
        rolcreaterole: false,
      });

      const owned = await db().client.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = '${RUNTIME}'`,
      );
      assert.equal(Number(owned[0]!.n), 0, 'owns no table, so cannot ALTER or DROP one');

      const missing = await db().client.$queryRawUnsafe<
        Array<{ table_name: string; privilege: string }>
      >(
        `SELECT t.table_name, p.privilege FROM information_schema.tables t
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilege)
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND t.table_name NOT IN ('_prisma_migrations', 'spatial_ref_sys')
            AND NOT (t.table_name IN ('admin_activity_logs', 'audit_field_changes') AND p.privilege IN ('UPDATE', 'DELETE'))
            AND NOT has_table_privilege('${RUNTIME}', 'public.' || quote_ident(t.table_name), p.privilege)`,
      );
      assert.deepEqual(missing, [], 'CRUD on every application table');

      const extra = await db().client.$queryRawUnsafe<
        Array<{ table_name: string; privilege: string }>
      >(
        `SELECT t.table_name, p.privilege FROM information_schema.tables t
           CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('REFERENCES')) AS p(privilege)
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND has_table_privilege('${RUNTIME}', 'public.' || quote_ident(t.table_name), p.privilege)`,
      );
      assert.deepEqual(extra, [], 'no TRUNCATE, TRIGGER or REFERENCES anywhere');

      const [audit] = await db().client.$queryRawUnsafe<Array<Record<string, boolean>>>(
        `SELECT has_table_privilege('${RUNTIME}', 'admin_activity_logs', 'INSERT') AS ins,
                has_table_privilege('${RUNTIME}', 'admin_activity_logs', 'UPDATE') AS upd,
                has_table_privilege('${RUNTIME}', 'admin_activity_logs', 'DELETE') AS del,
                has_table_privilege('${RUNTIME}', '_prisma_migrations', 'SELECT') AS migrations,
                has_schema_privilege('${RUNTIME}', 'public', 'CREATE') AS create_in_public`,
      );
      assert.deepEqual(audit, {
        ins: true,
        upd: false,
        del: false,
        migrations: false,
        create_in_public: false,
      });

      const sequences = await db().client.$queryRawUnsafe<Array<{ sequence_name: string }>>(
        `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
            AND NOT has_sequence_privilege('${RUNTIME}', 'public.' || quote_ident(sequence_name), 'USAGE')`,
      );
      assert.deepEqual(sequences, [], 'every sequence usable');
    });
  });
});
