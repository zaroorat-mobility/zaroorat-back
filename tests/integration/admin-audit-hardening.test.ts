import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  grantRole,
  makeDriver,
  makeRide,
  makeRideRequest,
  makeVehicle,
  makeVehicleType,
} from './helpers/fixtures.js';
import {
  allowAuditWrites,
  auditRows,
  refuseAuditWrites,
  results,
  SPOOFED_ACTOR_ID,
} from './helpers/audit.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { resolveQueue } from '../../src/jobs/queues/index.js';
import { getAlertAcks } from '../../src/modules/admin/monitoring-management/monitoring.store.js';

const ADMIN_PHONE = '+919876548001';
const SUPPORT_PHONE = '+919876548002';
const FINANCE_PHONE = '+919876548003';
const TARGET_PHONE = '+919876548004';
const SUBJECT_PHONE = '+919876548005';
const CUSTOMER_PHONE = '+919876548006';
const PASSWORD = 'Admin@12345';
const USER_AGENT = 'audit-hardening-test/1.0';

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

describe('admin audit hardening (integration)', () => {
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
    // `feature_flags` is not in resetState's TRUNCATE list, so this suite puts back
    // whatever it changed.
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
    const email = `${role}-${phone.slice(-4)}@hardening.test`;
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

  // ──────────────────────────────────────────────────────────── 1. push schedule ──
  describe('push schedule', () => {
    const schedule = (title = 'Monsoon offer'): InjectOptions => ({
      method: 'POST',
      url: '/api/v1/admin/communications/push/schedule',
      payload: {
        title,
        body: 'Rides are 20% off tonight',
        targeting: { roles: ['customer'] },
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        actorId: SPOOFED_ACTOR_ID,
      },
    });

    it('403 changes nothing and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const res = await as(support, schedule());
      assert.equal(res.statusCode, 403, res.payload);
      assert.equal(await db().client.adminBroadcast.count(), 0);
      assert.equal(await auditCount(), 0);
    });

    it('commits the broadcast with exactly one row naming the real actor', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const res = await as(admin, schedule());
      assert.equal(res.statusCode, 201, res.payload);
      const id = res.json().data.id as string;
      const broadcast = await db().client.adminBroadcast.findUniqueOrThrow({ where: { id } });
      assert.equal(broadcast.createdBy, admin.userId);
      const rows = await auditRows('admin_broadcast', id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'CREATE');
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).result, 'SUCCESS');
    });

    it('rolls the broadcast back when its audit row cannot be written', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await refuseAuditWrites('admin_broadcast');
      const res = await as(admin, schedule());
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(await db().client.adminBroadcast.count(), 0);
      assert.equal((await auditRows('admin_broadcast')).length, 0);
    });

    it('logs each of two concurrent schedules against its own broadcast', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const results_ = await Promise.all([as(admin, schedule('A')), as(admin, schedule('B'))]);
      assert.deepEqual(
        results_.map((r) => r.statusCode),
        [201, 201],
      );
      for (const r of results_) {
        assert.equal((await auditRows('admin_broadcast', r.json().data.id)).length, 1);
      }
    });
  });

  // ──────────────────────────────────────────────────────── 2. ops ride cancel ──
  describe('operations ride cancellation', () => {
    async function seedRide() {
      const customer = await loginAs(app, CUSTOMER_PHONE);
      const driverUser = await loginAs(app, SUBJECT_PHONE);
      const driverId = await makeDriver(driverUser.userId, { verified: true });
      const vehicleTypeId = await makeVehicleType();
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
      return makeRide({
        requestId,
        customerId: customer.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
        status: 'ACCEPTED',
      });
    }
    const cancel = (rideId: string): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/operations/rides/${rideId}/actions/cancel`,
      payload: {
        reasonCode: 'SAFETY',
        reasonText: 'Rider reported unsafe vehicle',
        actorId: SPOOFED_ACTOR_ID,
      },
    });
    const rideStatus = async (id: string) =>
      (await db().client.ride.findUniqueOrThrow({ where: { id } })).status;

    it('403 changes nothing and logs nothing', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const rideId = await seedRide();
      const res = await as(finance, cancel(rideId));
      assert.equal(res.statusCode, 403, res.payload);
      assert.equal(await rideStatus(rideId), 'ACCEPTED');
      assert.equal(await auditCount(), 0);
    });

    it('cancels with exactly one row naming the real actor', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const rideId = await seedRide();
      const res = await as(admin, cancel(rideId));
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await rideStatus(rideId), 'CANCELLED_BY_SYSTEM');
      const rows = await auditRows('ride', rideId);
      assert.equal(rows.length, 1);
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).before?.status, 'ACCEPTED');
      assert.equal(meta(rows[0]!).after?.status, 'CANCELLED_BY_SYSTEM');
      assert.equal(meta(rows[0]!).after?.reasonCode, 'SAFETY');
    });

    it('rolls the cancellation back — status, history, events — with a failed audit write', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const rideId = await seedRide();
      await refuseAuditWrites('ride');
      const res = await as(admin, cancel(rideId));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(await rideStatus(rideId), 'ACCEPTED');
      assert.equal(await db().client.rideStatusEvent.count({ where: { rideId } }), 0);
      assert.equal(
        await db().client.outboxEvent.count({ where: { eventType: 'ride.cancelled' } }),
        0,
      );
      assert.equal((await auditRows('ride', rideId)).length, 0);
    });

    it('two concurrent cancels: one succeeds, one is refused, one row', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const rideId = await seedRide();
      const res = await Promise.all([as(admin, cancel(rideId)), as(admin, cancel(rideId))]);
      const codes = res.map((r) => r.statusCode).sort();
      assert.equal(codes[0], 200, res.map((r) => r.payload).join('\n'));
      assert.ok(codes[1]! >= 400 && codes[1]! < 500, `the loser is refused: ${codes[1]}`);
      assert.equal((await auditRows('ride', rideId)).length, 1);
    });
  });

  // ─────────────────────────────────────────────────────────── 3. force logout ──
  describe('force logout', () => {
    const forceLogout = (userId?: string): InjectOptions => ({
      method: 'POST',
      url: '/api/v1/admin/security/force-logout-all',
      payload: { ...(userId ? { userId } : {}), actorId: SPOOFED_ACTOR_ID },
    });
    const activeSessions = (userId: string) =>
      db().client.userSession.count({ where: { userId, revokedAt: null } });
    const activeAdminSessions = (userId: string) =>
      db().client.adminSession.count({ where: { userId, revokedAt: null } });
    const me = (staff: Staff) =>
      app.inject({ method: 'GET', url: '/api/v1/users/me', headers: staff.headers });

    it('403 revokes nothing and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const before_ = await activeSessions(target.userId);
      const res = await as(support, forceLogout(target.userId));
      assert.equal(res.statusCode, 403, res.payload);
      assert.equal(await activeSessions(target.userId), before_);
      assert.equal((await me(target)).statusCode, 200);
      assert.equal(await auditCount(), 0);
    });

    it('logs out one account with exactly one row naming the real actor', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const sessions = await activeSessions(target.userId);
      const res = await as(admin, forceLogout(target.userId));
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await activeSessions(target.userId), 0);
      assert.equal(await activeAdminSessions(target.userId), 0);
      assert.equal((await me(target)).statusCode, 401, 'the epoch bump retired the token');
      const rows = await auditRows('staff_user', target.userId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'LOGOUT');
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).after?.sessionsRevoked, sessions);
    });

    it('rolls the account back — sessions and token intact — when its audit row fails', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const sessions = await activeSessions(target.userId);
      await refuseAuditWrites('staff_user');
      const res = await as(admin, forceLogout(target.userId));
      assert.equal(res.statusCode, 500, 'a partial run is never reported as success');
      assert.equal(await activeSessions(target.userId), sessions);
      assert.ok((await activeAdminSessions(target.userId)) >= 1);
      assert.equal((await me(target)).statusCode, 200, 'no epoch bump for a rolled-back account');
      assert.equal((await auditRows('staff_user')).length, 0);
    });

    it('a failure for one account leaves only that account unchanged and unlogged', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const other = await loginStaff(SUPPORT_PHONE, 'support');
      await refuseAuditWrites('staff_user', target.userId);

      const res = await as(admin, forceLogout());

      // 5xx bodies are masked by the global handler; the audit trail is the record of
      // exactly which accounts were logged out.
      assert.equal(res.statusCode, 500, 'a partial run is never reported as success');
      assert.ok((await activeSessions(target.userId)) >= 1, 'the failed account is untouched');
      assert.equal((await auditRows('staff_user', target.userId)).length, 0);
      for (const done of [admin, other]) {
        assert.equal(await activeSessions(done.userId), 0);
        assert.equal((await auditRows('staff_user', done.userId)).length, 1);
      }
    });

    it('two concurrent logouts of one account record the true split of revoked sessions', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(TARGET_PHONE, 'finance');
      const sessions = await activeSessions(target.userId);
      const res = await Promise.all([
        as(admin, forceLogout(target.userId)),
        as(admin, forceLogout(target.userId)),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [200, 200],
      );
      const rows = await auditRows('staff_user', target.userId);
      assert.equal(rows.length, 2, 'each logout bumped the epoch, so each is logged');
      const revoked = rows.map((r) => Number(meta(r).after?.sessionsRevoked)).sort();
      assert.deepEqual(revoked, [0, sessions], 'no session is claimed twice');
    });
  });

  // ─────────────────────────────────────────────────────────── 4. feature flags ──
  describe('feature flags', () => {
    async function snapshotFlags() {
      await as(await loginStaff(ADMIN_PHONE, 'system_admin'), {
        method: 'GET',
        url: '/api/v1/admin/settings/feature-flags',
      });
      flagsSnapshot = await db().client.featureFlag.findMany({
        select: { key: true, status: true, rolloutPercentage: true, isActive: true },
      });
    }
    const update = (flags: Array<Record<string, unknown>>): InjectOptions => ({
      method: 'PUT',
      url: '/api/v1/admin/settings/feature-flags',
      payload: { flags, actorId: SPOOFED_ACTOR_ID },
    });
    const flag = (key: string) => db().client.featureFlag.findUniqueOrThrow({ where: { key } });

    it('403 changes nothing and logs nothing', async () => {
      await snapshotFlags();
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const before_ = await flag('surge');
      const res = await as(support, update([{ key: 'surge', rolloutPercentage: 5 }]));
      assert.equal(res.statusCode, 403, res.payload);
      assert.equal((await flag('surge')).rolloutPercentage, before_.rolloutPercentage);
      assert.equal(await auditCount(), 0);
    });

    it('writes one row per flag with the value each write replaced', async () => {
      await snapshotFlags();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const surge = await flag('surge');
      const res = await as(
        admin,
        update([
          { key: 'surge', rolloutPercentage: 25, status: 'PARTIAL' },
          { key: 'driver_incentives', isActive: false },
        ]),
      );
      assert.equal(res.statusCode, 200, res.payload);
      const rows = await auditRows('feature_flag');
      assert.equal(rows.length, 2);
      for (const row of rows) assertActor(row, admin);
      const surgeRow = rows.find((r) => r.entityId === surge.id)!;
      assert.equal(meta(surgeRow).before?.rolloutPercentage, surge.rolloutPercentage);
      assert.equal(meta(surgeRow).after?.rolloutPercentage, 25);
      assert.equal(meta(surgeRow).after?.status, 'PARTIAL');
    });

    it('an unknown key in the batch leaves every flag unchanged and unlogged', async () => {
      await snapshotFlags();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const before_ = await flag('surge');
      const res = await as(
        admin,
        update([
          { key: 'surge', rolloutPercentage: 33 },
          { key: 'no_such_flag', isActive: false },
        ]),
      );
      assert.equal(res.statusCode, 400, res.payload);
      assert.equal((await flag('surge')).rolloutPercentage, before_.rolloutPercentage);
      assert.equal(await auditCount(), 0);
    });

    it('a failed audit write rolls every flag in the batch back', async () => {
      await snapshotFlags();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const surge = await flag('surge');
      const incentives = await flag('driver_incentives');
      await refuseAuditWrites('feature_flag', incentives.id);
      const res = await as(
        admin,
        update([
          { key: 'surge', rolloutPercentage: 44 },
          { key: 'driver_incentives', rolloutPercentage: 44 },
        ]),
      );
      // A failed write is the server's fault: masked 500, never a 400 with database text.
      assert.equal(res.statusCode, 500, res.payload);
      assert.equal((await flag('surge')).rolloutPercentage, surge.rolloutPercentage);
      assert.equal(
        (await flag('driver_incentives')).rolloutPercentage,
        incentives.rolloutPercentage,
      );
      assert.equal((await auditRows('feature_flag')).length, 0);
    });

    it('two concurrent edits of one flag chain before → after', async () => {
      await snapshotFlags();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const original = (await flag('surge')).rolloutPercentage;
      const res = await Promise.all([
        as(admin, update([{ key: 'surge', rolloutPercentage: 11 }])),
        as(admin, update([{ key: 'surge', rolloutPercentage: 22 }])),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [200, 200],
      );
      const rows = await auditRows('feature_flag');
      const first = rows.find((r) => meta(r).before?.rolloutPercentage === original)!;
      const second = rows.find((r) => r !== first)!;
      assert.ok(first, 'one edit replaced the original value');
      assert.equal(meta(second).before?.rolloutPercentage, meta(first).after?.rolloutPercentage);
      assert.equal((await flag('surge')).rolloutPercentage, meta(second).after?.rolloutPercentage);
    });
  });

  // ──────────────────────────────── 5/6. driver verification and document review ──
  describe('driver verification and document review', () => {
    const SECRET_NUMBER = 'DL-SECRET-0042';

    async function seedPendingDriver() {
      const user = await loginAs(app, SUBJECT_PHONE);
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
      return { user, driverId, docs };
    }
    const verificationStatus = async (id: string) =>
      (await db().client.driver.findUniqueOrThrow({ where: { id } })).verificationStatus;
    const verify = (driverId: string, payload: Record<string, unknown>): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/verify`,
      payload: { ...payload, actorId: SPOOFED_ACTOR_ID },
    });
    const review = (driverId: string, documentId: string): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/documents/${documentId}/review`,
      payload: { status: 'VERIFIED', actorId: SPOOFED_ACTOR_ID },
    });
    function assertNoDocumentSecrets(rows: Array<{ metadata: unknown }>) {
      const text = JSON.stringify(rows.map((r) => r.metadata));
      assert.doesNotMatch(text, new RegExp(SECRET_NUMBER), 'no document number');
      assert.doesNotMatch(text, /example\.invalid|fileUrl|fileId/, 'no file location');
    }

    it('403: verify and document review change nothing and log nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const { driverId, docs } = await seedPendingDriver();
      assert.equal(
        (await as(support, verify(driverId, { status: 'REJECTED', rejectionReason: 'x' })))
          .statusCode,
        403,
      );
      assert.equal((await as(support, review(driverId, docs[0]!.id))).statusCode, 403);
      assert.equal(await verificationStatus(driverId), 'PENDING');
      assert.equal(
        (await db().client.driverDocument.findUniqueOrThrow({ where: { id: docs[0]!.id } }))
          .verificationStatus,
        'PENDING',
      );
      assert.equal(await auditCount(), 0);
    });

    it('a rejection writes one REJECT row with before/after and the reason, no secrets', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId } = await seedPendingDriver();
      const res = await as(
        admin,
        verify(driverId, { status: 'REJECTED', rejectionReason: 'Blurred licence' }),
      );
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await verificationStatus(driverId), 'REJECTED');
      const rows = await auditRows('driver', driverId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'REJECT');
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).before?.verificationStatus, 'PENDING');
      assert.equal(meta(rows[0]!).after?.verificationStatus, 'REJECTED');
      assert.equal(meta(rows[0]!).notes, 'Blurred licence');
      assertNoDocumentSecrets(rows);
    });

    it('a repeated or concurrent approval changes and logs once', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId } = await seedPendingDriver();
      await db().client.driverDocument.updateMany({
        where: { driverId },
        data: { verificationStatus: 'VERIFIED' },
      });
      const res = await Promise.all([
        as(admin, verify(driverId, { status: 'VERIFIED' })),
        as(admin, verify(driverId, { status: 'VERIFIED' })),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [200, 200],
      );
      const retry = await as(admin, verify(driverId, { status: 'VERIFIED' }));
      assert.equal(retry.statusCode, 200, retry.payload);
      const rows = await auditRows('driver', driverId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'APPROVE');
    });

    it('a failed audit write rolls the verification decision and its event back', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId } = await seedPendingDriver();
      await db().client.driverDocument.updateMany({
        where: { driverId },
        data: { verificationStatus: 'VERIFIED' },
      });
      await refuseAuditWrites('driver');
      const res = await as(admin, verify(driverId, { status: 'VERIFIED' }));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(await verificationStatus(driverId), 'PENDING');
      assert.equal(await db().client.outboxEvent.count({ where: { aggregateId: driverId } }), 0);
      assert.equal((await auditRows('driver', driverId)).length, 0);
    });

    it('application approval promotes documents, verifies the driver, and logs each — atomically', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId, docs } = await seedPendingDriver();
      const res = await as(admin, {
        method: 'POST',
        url: `/api/v1/admin/applications/${driverId}/approve`,
        payload: { notes: 'All good', actorId: SPOOFED_ACTOR_ID },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await verificationStatus(driverId), 'VERIFIED');
      const docRows = await db().client.adminActivityLog.findMany({
        where: { entityType: 'driver_document', entityId: { in: docs.map((d) => d.id) } },
      });
      assert.equal(docRows.length, docs.length, 'one row per promoted document');
      const driverRows = await auditRows('driver', driverId);
      assert.equal(driverRows.length, 1);
      for (const row of [...docRows, ...driverRows]) assertActor(row, admin);
      assertNoDocumentSecrets([...docRows, ...driverRows]);
    });

    it('a failed approval leaves documents and driver untouched and logs nothing', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId } = await seedPendingDriver();
      await refuseAuditWrites('driver');
      const res = await as(admin, {
        method: 'POST',
        url: `/api/v1/admin/applications/${driverId}/approve`,
        payload: {},
      });
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(await verificationStatus(driverId), 'PENDING');
      assert.equal(
        await db().client.driverDocument.count({
          where: { driverId, verificationStatus: 'VERIFIED' },
        }),
        0,
        'the document promotion rolled back with the decision',
      );
      assert.equal(await auditCount(), 0);
    });

    it('a document review writes one row; concurrent and repeated reviews add none', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId, docs } = await seedPendingDriver();
      const docId = docs[0]!.id;
      const res = await Promise.all([
        as(admin, review(driverId, docId)),
        as(admin, review(driverId, docId)),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [200, 200],
      );
      assert.equal((await as(admin, review(driverId, docId))).statusCode, 200);
      const rows = await auditRows('driver_document', docId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'APPROVE');
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).before?.verificationStatus, 'PENDING');
      assert.equal(meta(rows[0]!).after?.verificationStatus, 'VERIFIED');
      assertNoDocumentSecrets(rows);
    });

    it('a failed audit write rolls the document review back', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId, docs } = await seedPendingDriver();
      await refuseAuditWrites('driver_document');
      const res = await as(admin, review(driverId, docs[0]!.id));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      const doc = await db().client.driverDocument.findUniqueOrThrow({
        where: { id: docs[0]!.id },
      });
      assert.equal(doc.verificationStatus, 'PENDING');
      assert.equal(doc.verifiedBy, null);
      assert.equal((await auditRows('driver_document')).length, 0);
    });
  });

  // ───────────────────────────────────────────── 7. background job retry/remove ──
  describe('background job actions (Redis)', () => {
    const QUEUE = 'files-maintenance';
    async function seedJob() {
      const job = await resolveQueue(QUEUE)!.add('audit-test', {
        otp: '918273',
        phone: '+919999999999',
      });
      return String(job.id);
    }
    const mutate = (jobId: string, action: 'retry' | 'remove'): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/jobs/${QUEUE}/${jobId}`,
      payload: { action, actorId: SPOOFED_ACTOR_ID },
    });
    const jobExists = async (id: string) => Boolean(await resolveQueue(QUEUE)!.getJob(id));

    it('403 leaves the job and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const jobId = await seedJob();
      const res = await as(support, mutate(jobId, 'remove'));
      assert.equal(res.statusCode, 403, res.payload);
      assert.ok(await jobExists(jobId));
      assert.equal(await auditCount(), 0);
    });

    it('a removal is logged REQUESTED then SUCCESS, without the job payload', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const jobId = await seedJob();
      const res = await as(admin, mutate(jobId, 'remove'));
      assert.equal(res.statusCode, 204, res.payload);
      assert.equal(await jobExists(jobId), false);
      const rows = await auditRows('background_job');
      assert.deepEqual(results(rows), ['REQUESTED', 'SUCCESS']);
      for (const row of rows) assertActor(row, admin);
      assert.equal(meta(rows[0]!).before?.jobId, jobId);
      assert.doesNotMatch(JSON.stringify(rows.map((r) => r.metadata)), /918273|9999999999/);
    });

    it('a refused action is logged REQUESTED then FAILED, never SUCCESS', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const jobId = await seedJob();
      // A waiting job has not failed, so BullMQ refuses to retry it.
      const res = await as(admin, mutate(jobId, 'retry'));
      assert.ok(res.statusCode >= 400, `${res.statusCode} ${res.payload}`);
      assert.ok(await jobExists(jobId));
      assert.deepEqual(results(await auditRows('background_job')), ['REQUESTED', 'FAILED']);
    });

    it('when the request cannot be logged, the job is not touched', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const jobId = await seedJob();
      await refuseAuditWrites('background_job');
      const res = await as(admin, mutate(jobId, 'remove'));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.ok(await jobExists(jobId), 'never acted on unlogged');
      assert.equal((await auditRows('background_job')).length, 0);
    });

    it('concurrent removals leave every REQUESTED row with exactly one outcome', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const jobId = await seedJob();
      await Promise.all([as(admin, mutate(jobId, 'remove')), as(admin, mutate(jobId, 'remove'))]);
      assert.equal(await jobExists(jobId), false);
      const r = results(await auditRows('background_job'));
      const requested = r.filter((x) => x === 'REQUESTED').length;
      assert.equal(r.length, requested * 2, 'no orphan request, no outcome without a request');
      assert.ok(r.includes('SUCCESS'));
    });
  });

  // ─────────────────────────────────────────────────────── 8. alert acknowledge ──
  describe('alert acknowledgement (Redis)', () => {
    const ALERT = 'queue_backlog:files-maintenance';
    const ack = (): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/monitoring/alerts/${encodeURIComponent(ALERT)}/ack`,
      payload: { actorId: SPOOFED_ACTOR_ID },
    });

    it('403 acknowledges nothing and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const res = await as(support, ack());
      assert.equal(res.statusCode, 403, res.payload);
      assert.equal((await getAlertAcks()).has(ALERT), false);
      assert.equal(await auditCount(), 0);
    });

    it('is logged REQUESTED then SUCCESS; a repeat is refused 409 and logs nothing more', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const res = await as(admin, ack());
      assert.ok(res.statusCode < 300, res.payload);
      assert.equal((await getAlertAcks()).get(ALERT)?.actorId, admin.userId);
      const rows = await auditRows('monitoring_alert');
      assert.deepEqual(results(rows), ['REQUESTED', 'SUCCESS']);
      for (const row of rows) assertActor(row, admin);

      assert.equal((await as(admin, ack())).statusCode, 409);
      assert.equal((await auditRows('monitoring_alert')).length, 2, 'no row for a refused repeat');
    });

    it('when the request cannot be logged, the alert is not acknowledged', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await refuseAuditWrites('monitoring_alert');
      const res = await as(admin, ack());
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal((await getAlertAcks()).has(ALERT), false);
      assert.equal((await auditRows('monitoring_alert')).length, 0);
    });

    it('concurrent acknowledgements: one SUCCESS, and no request without an outcome', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await Promise.all([as(admin, ack()), as(admin, ack())]);
      const r = results(await auditRows('monitoring_alert'));
      assert.equal(r.filter((x) => x === 'SUCCESS').length, 1);
      assert.equal(
        r.filter((x) => x === 'REQUESTED').length,
        r.filter((x) => x === 'SUCCESS' || x === 'NO_OP').length,
      );
    });
  });

  // ─────────────────────────────────────────── 10. database-level append-only ──
  describe('append-only, enforced by PostgreSQL', () => {
    async function seedRow() {
      const user = await loginAs(app, SUBJECT_PHONE);
      return db().client.adminActivityLog.create({
        data: { actorId: user.userId, action: 'UPDATE', entityType: 'probe', summary: 'original' },
      });
    }

    it('refuses UPDATE and DELETE through Prisma and raw SQL, for the app role', async () => {
      const row = await seedRow();
      await assert.rejects(
        db().client.adminActivityLog.update({ where: { id: row.id }, data: { summary: 'x' } }),
        /append-only/,
      );
      await assert.rejects(
        db().client.adminActivityLog.deleteMany({ where: { id: row.id } }),
        /append-only/,
      );
      await assert.rejects(
        db().client.$executeRawUnsafe(
          `UPDATE admin_activity_logs SET actor_id = NULL WHERE id = '${row.id}'::uuid`,
        ),
        /append-only/,
      );
      const after_ = await db().client.adminActivityLog.findUniqueOrThrow({
        where: { id: row.id },
      });
      assert.equal(after_.summary, 'original');
      assert.equal(after_.actorId, row.actorId);
    });

    it('protects audit_field_changes the same way', async () => {
      const row = await seedRow();
      const change = await db().client.auditFieldChange.create({
        data: { activityLogId: row.id, fieldName: 'status', oldValue: 'A', newValue: 'B' },
      });
      await assert.rejects(
        db().client.auditFieldChange.delete({ where: { id: change.id } }),
        /append-only/,
      );
    });
  });

  // ──────────────────────────────────────────────── 11. durable actor identity ──
  describe('actor identity survives', () => {
    it('a user who acted as an admin cannot be hard-deleted; their rows keep the actor', async () => {
      const actor = await db().client.user.create({ data: { phoneNumber: '+919876548090' } });
      const row = await db().client.adminActivityLog.create({
        data: { actorId: actor.id, action: 'UPDATE', entityType: 'probe' },
      });
      await assert.rejects(db().client.user.delete({ where: { id: actor.id } }));
      const kept = await db().client.adminActivityLog.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(kept.actorId, actor.id);
    });

    it('a user with no audit history deletes exactly as before', async () => {
      const user = await db().client.user.create({ data: { phoneNumber: '+919876548091' } });
      await db().client.user.delete({ where: { id: user.id } });
      assert.equal(await db().client.user.count({ where: { id: user.id } }), 0);
    });

    it('a deactivated admin still resolves as the actor of their rows', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const res = await as(admin, {
        method: 'POST',
        url: '/api/v1/admin/monitoring/alerts/deactivation-probe/ack',
      });
      assert.ok(res.statusCode < 300, res.payload);
      await db().client.user.update({
        where: { id: admin.userId },
        data: { status: 'DEACTIVATED', deletedAt: new Date() },
      });
      const rows = await db().client.adminActivityLog.findMany({
        where: { entityType: 'monitoring_alert' },
        include: { actor: true },
      });
      assert.ok(rows.length > 0);
      for (const row of rows) assert.equal(row.actor?.id, admin.userId);
    });
  });
});
