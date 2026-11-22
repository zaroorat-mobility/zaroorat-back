import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

const ADMIN_PHONE = '+919876549001';
const SUPPORT_PHONE = '+919876549002';
const FINANCE_PHONE = '+919876549003';
const SUBJECT_PHONE = '+919876549004';
const CUSTOMER_PHONE = '+919876549005';
const PASSWORD = 'Admin@12345';
const USER_AGENT = 'audit-completion-test/1.0';
const SECRET_DOC_NUMBER = 'RC-SECRET-7731';

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

describe('admin audit completion (integration)', () => {
  let app: FastifyInstance;
  let restore: Array<() => Promise<unknown>> = [];

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
    // State that resetState does not truncate, put back by the test that changed it.
    for (const undo of restore.reverse()) await undo();
    restore = [];
    await resetState();
  });

  async function loginStaff(phone: string, role: string): Promise<Staff> {
    const email = `${role}-${phone.slice(-4)}@completion.test`;
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

  // ─────────────────────────────────────────────── N4. vehicle verification ──
  describe('N4 vehicle verification and document review', () => {
    async function seedPendingVehicle() {
      const vehicleId = await makeVehicle(await makeVehicleType());
      await db().client.vehicle.update({
        where: { id: vehicleId },
        data: { verificationStatus: 'PENDING', verifiedAt: null },
      });
      await db().client.vehicleDocument.updateMany({
        where: { vehicleId },
        data: {
          verificationStatus: 'PENDING',
          documentNumber: SECRET_DOC_NUMBER,
          fileUrl: 'https://files.example.invalid/rc.jpg',
        },
      });
      const docs = await db().client.vehicleDocument.findMany({ where: { vehicleId } });
      return { vehicleId, docs };
    }
    const verify = (vehicleId: string, payload: Record<string, unknown>): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/vehicles/${vehicleId}/verify`,
      payload: { ...payload, actorId: SPOOFED_ACTOR_ID },
    });
    const review = (vehicleId: string, documentId: string): InjectOptions => ({
      method: 'POST',
      url: `/api/v1/admin/vehicles/${vehicleId}/documents/${documentId}/review`,
      payload: { status: 'VERIFIED', actorId: SPOOFED_ACTOR_ID },
    });
    const vehicleStatus = async (id: string) =>
      (await db().client.vehicle.findUniqueOrThrow({ where: { id } })).verificationStatus;
    function assertNoDocumentSecrets(rows: Array<{ metadata: unknown }>) {
      const text = JSON.stringify(rows.map((r) => r.metadata));
      assert.doesNotMatch(text, new RegExp(SECRET_DOC_NUMBER));
      assert.doesNotMatch(text, /example\.invalid|fileUrl|fileId/);
    }

    it('403 changes nothing and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const { vehicleId, docs } = await seedPendingVehicle();
      assert.equal((await as(support, verify(vehicleId, { status: 'REJECTED' }))).statusCode, 403);
      assert.equal((await as(support, review(vehicleId, docs[0]!.id))).statusCode, 403);
      assert.equal(await vehicleStatus(vehicleId), 'PENDING');
      assert.equal(await auditCount(), 0);
    });

    it('document review then approval: one row each, real actor, no document secrets', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { vehicleId, docs } = await seedPendingVehicle();
      for (const doc of docs) {
        const res = await as(admin, review(vehicleId, doc.id));
        assert.equal(res.statusCode, 200, res.payload);
      }
      const approved = await as(admin, verify(vehicleId, { status: 'VERIFIED' }));
      assert.equal(approved.statusCode, 200, approved.payload);
      assert.equal(await vehicleStatus(vehicleId), 'VERIFIED');

      const docRows = await db().client.adminActivityLog.findMany({
        where: { entityType: 'vehicle_document' },
      });
      assert.equal(docRows.length, docs.length);
      const vehicleRows = await auditRows('vehicle', vehicleId);
      assert.equal(vehicleRows.length, 1);
      assert.equal(vehicleRows[0]!.action, 'APPROVE');
      assert.equal(meta(vehicleRows[0]!).before?.verificationStatus, 'PENDING');
      assert.equal(meta(vehicleRows[0]!).after?.verificationStatus, 'VERIFIED');
      for (const row of [...docRows, ...vehicleRows]) assertActor(row, admin);
      assertNoDocumentSecrets([...docRows, ...vehicleRows]);
    });

    it('a failed audit write rolls the vehicle decision and the document review back', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { vehicleId, docs } = await seedPendingVehicle();
      await refuseAuditWrites('vehicle');
      const res = await as(admin, verify(vehicleId, { status: 'REJECTED', rejectionReason: 'x' }));
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(await vehicleStatus(vehicleId), 'PENDING');

      await refuseAuditWrites('vehicle_document');
      const reviewed = await as(admin, review(vehicleId, docs[0]!.id));
      assert.ok(reviewed.statusCode >= 500, `${reviewed.statusCode} ${reviewed.payload}`);
      const doc = await db().client.vehicleDocument.findUniqueOrThrow({
        where: { id: docs[0]!.id },
      });
      assert.equal(doc.verificationStatus, 'PENDING');
      assert.equal(await auditCount(), 0);
    });

    it('concurrent and repeated decisions change and log once', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { vehicleId, docs } = await seedPendingVehicle();
      const reviews = await Promise.all([
        as(admin, review(vehicleId, docs[0]!.id)),
        as(admin, review(vehicleId, docs[0]!.id)),
      ]);
      assert.deepEqual(
        reviews.map((r) => r.statusCode),
        [200, 200],
      );
      const rejects = await Promise.all([
        as(admin, verify(vehicleId, { status: 'REJECTED', rejectionReason: 'Blurred RC' })),
        as(admin, verify(vehicleId, { status: 'REJECTED', rejectionReason: 'Blurred RC' })),
      ]);
      assert.deepEqual(
        rejects.map((r) => r.statusCode),
        [200, 200],
      );
      assert.equal((await auditRows('vehicle_document', docs[0]!.id)).length, 1);
      const vehicleRows = await auditRows('vehicle', vehicleId);
      assert.equal(vehicleRows.length, 1);
      assert.equal(meta(vehicleRows[0]!).notes, 'Blurred RC');
    });
  });

  // ──────────────────────────────────────────────── N1. subscription plans ──
  describe('N1 subscription plan creation', () => {
    const PLAN = `AUDIT PLAN ${randomUUID().slice(0, 6)}`;
    const create = (key?: string, name = PLAN): InjectOptions => ({
      method: 'POST',
      url: '/api/v1/subscriptions/plans',
      payload: { name, billingPeriod: 'MONTHLY', price: 499, actorId: SPOOFED_ACTOR_ID },
      ...(key ? { headers: { 'idempotency-key': key } } : {}),
    });
    const plans = (name = PLAN) => db().client.subscriptionPlan.count({ where: { name } });
    beforeEach(() => {
      restore.push(() =>
        db().client.subscriptionPlan.deleteMany({ where: { name: { startsWith: 'AUDIT PLAN' } } }),
      );
    });

    it('403 for staff without finance:execute: no plan, no row', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      assert.equal((await as(support, create())).statusCode, 403);
      assert.equal(await plans(), 0);
      assert.equal(await auditCount(), 0);
    });

    it('commits the plan with one CREATE row holding the price and the real actor', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const res = await as(finance, create());
      assert.equal(res.statusCode, 201, res.payload);
      const rows = await auditRows('subscription_plan', res.json().data.id);
      assert.equal(rows.length, 1);
      assertActor(rows[0]!, finance);
      assert.equal(meta(rows[0]!).after?.price, '499.00');
      assert.equal(meta(rows[0]!).after?.billingPeriod, 'MONTHLY');
    });

    it('a failed audit write leaves no plan', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      await refuseAuditWrites('subscription_plan');
      const res = await as(finance, create());
      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(await plans(), 0);
    });

    it('an Idempotency-Key makes retries and concurrent duplicates one plan and one row', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const key = randomUUID();
      const res = await Promise.all([as(finance, create(key)), as(finance, create(key))]);
      for (const r of res) {
        assert.ok(
          r.statusCode === 201 ||
            (r.statusCode === 409 && r.json().error.code === 'IDEMPOTENCY_IN_PROGRESS'),
          r.payload,
        );
      }
      const replay = await as(finance, create(key));
      assert.equal(replay.statusCode, 201, replay.payload);
      assert.equal(await plans(), 1);
      assert.equal((await auditRows('subscription_plan')).length, 1);
    });
  });

  // ──────────────────────────────────────────────── N5. settlement generation ──
  describe('N5 settlement generation', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date(new Date().toISOString().slice(0, 10));
    const period = {
      periodStart: new Date(today.getTime() - dayMs).toISOString().slice(0, 10),
      periodEnd: new Date(today.getTime() + dayMs).toISOString().slice(0, 10),
    };

    /// One driver with one completed legacy WALLET ride paying them 300: the one shape
    /// that still produces a positive settlement, so the wallet credit itself is under
    /// test. New WALLET rides are refused by a trigger, so the ride is converted with the
    /// trigger off — as a historical row would have been written.
    async function seedEarningDriver() {
      const customer = await loginAs(app, CUSTOMER_PHONE);
      const driverUser = await loginAs(app, SUBJECT_PHONE);
      const driverId = await makeDriver(driverUser.userId, { verified: true });
      await db().client.driverWallet.create({ data: { driverId, balance: 0, lockedBalance: 0 } });
      const vehicleTypeId = await makeVehicleType();
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
      const rideId = await makeRide({
        requestId,
        customerId: customer.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
        status: 'COMPLETED',
      });
      await db().client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE rides DISABLE TRIGGER trg_check_no_new_wallet_ride',
        );
        await tx.$executeRawUnsafe(
          `UPDATE rides SET payment_method = 'WALLET', completed_at = now() WHERE id = $1::uuid`,
          rideId,
        );
        await tx.$executeRawUnsafe('ALTER TABLE rides ENABLE TRIGGER trg_check_no_new_wallet_ride');
      });
      await db().client.rideFare.create({
        data: {
          rideId,
          baseFare: 400,
          distanceFare: 0,
          timeFare: 0,
          subtotal: 400,
          totalFare: 400,
          driverEarning: 300,
          platformCommission: 100,
        },
      });
      return driverId;
    }
    const generate = (): InjectOptions => ({
      method: 'POST',
      url: '/api/v1/admin/finance/settlements/generate',
      payload: { ...period, actorId: SPOOFED_ACTOR_ID },
    });
    const balance = async (driverId: string) =>
      Number((await db().client.driverWallet.findUniqueOrThrow({ where: { driverId } })).balance);

    it('403 settles nobody and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const driverId = await seedEarningDriver();
      assert.equal((await as(support, generate())).statusCode, 403);
      assert.equal(await db().client.driverSettlement.count(), 0);
      assert.equal(await balance(driverId), 0);
      assert.equal(await auditCount(), 0);
    });

    it('each credit commits with its own row; the batch with its own', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const driverId = await seedEarningDriver();
      const res = await as(finance, generate());
      assert.equal(res.statusCode, 201, res.payload);
      assert.equal(await balance(driverId), 300);
      const settlement = await db().client.driverSettlement.findFirstOrThrow({
        where: { driverId },
      });
      const driverRows = await auditRows('driver_settlement', settlement.id);
      assert.equal(driverRows.length, 1);
      assert.equal(meta(driverRows[0]!).after?.walletCredited, '300.00');
      const batchRows = await auditRows('settlement', res.json().data.id);
      assert.equal(batchRows.length, 1);
      for (const row of [...driverRows, ...batchRows]) assertActor(row, finance);
    });

    it('a failed driver audit leaves no credit and no batch; the retry credits once', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const driverId = await seedEarningDriver();
      await refuseAuditWrites('driver_settlement');
      const refused = await as(finance, generate());
      assert.equal(refused.statusCode, 409, refused.payload);
      assert.equal(await balance(driverId), 0, 'no credit without its audit row');
      assert.equal(await db().client.driverSettlement.count(), 0);
      assert.equal(await db().client.settlementBatch.count(), 0);
      assert.equal(await auditCount(), 0);

      await allowAuditWrites();
      assert.equal((await as(finance, generate())).statusCode, 201);
      assert.equal(await balance(driverId), 300);
      assert.equal((await auditRows('driver_settlement')).length, 1);
    });

    it('a failed batch audit keeps the audited credits; the retry batches without re-crediting', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const driverId = await seedEarningDriver();
      await refuseAuditWrites('settlement');
      const refused = await as(finance, generate());
      assert.ok(refused.statusCode >= 500, `${refused.statusCode} ${refused.payload}`);
      assert.equal(await db().client.settlementBatch.count(), 0);
      assert.equal(await balance(driverId), 300);
      assert.equal((await auditRows('driver_settlement')).length, 1, 'the credit is accounted for');

      await allowAuditWrites();
      const retried = await as(finance, generate());
      assert.equal(retried.statusCode, 201, retried.payload);
      assert.equal(await balance(driverId), 300, 'never credited twice');
      assert.equal((await auditRows('driver_settlement')).length, 1);
      assert.equal((await auditRows('settlement')).length, 1);
    });

    it('concurrent generations make one batch, one credit, one row each', async () => {
      const finance = await loginStaff(FINANCE_PHONE, 'finance');
      const driverId = await seedEarningDriver();
      const res = await Promise.all([as(finance, generate()), as(finance, generate())]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [201, 201],
      );
      assert.equal(res[0]!.json().data.id, res[1]!.json().data.id, 'the same batch');
      assert.equal(await db().client.settlementBatch.count(), 1);
      assert.equal(await balance(driverId), 300);
      assert.equal((await auditRows('driver_settlement')).length, 1);
      assert.equal((await auditRows('settlement')).length, 1);
    });
  });

  // ──────────────────────────────────────────────────── N3. maintenance window ──
  describe('N3 maintenance settings and windows', () => {
    beforeEach(() => {
      restore.push(async () => {
        await db().client.systemSetting.deleteMany({ where: { category: 'maintenance' } });
        await db().client.maintenanceWindow.deleteMany({
          where: { title: { startsWith: 'AUDIT' } },
        });
      });
    });
    const update = (message: string, schedule = true): InjectOptions => ({
      method: 'PUT',
      url: '/api/v1/admin/settings/maintenance',
      payload: {
        // Never `enabled: true` here — it would take every later suite offline.
        enabled: false,
        message,
        ...(schedule
          ? {
              schedule: {
                title: 'AUDIT window',
                startsAt: new Date(Date.now() + 86_400_000).toISOString(),
                endsAt: new Date(Date.now() + 90_000_000).toISOString(),
              },
            }
          : {}),
        actorId: SPOOFED_ACTOR_ID,
      },
    });
    const windows = () =>
      db().client.maintenanceWindow.count({ where: { title: { startsWith: 'AUDIT' } } });
    const message = async () =>
      (
        await db().client.systemSetting.findFirst({
          where: { category: 'maintenance', key: { contains: 'message' } },
        })
      )?.value ?? null;

    it('403 schedules nothing and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      assert.equal((await as(support, update('Down for upgrades'))).statusCode, 403);
      assert.equal(await windows(), 0);
      assert.equal(await message(), null);
      assert.equal(await auditCount(), 0);
    });

    it('commits settings and window with one row holding before/after', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const res = await as(admin, update('Down for upgrades'));
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await windows(), 1);
      const rows = await auditRows('maintenance_settings');
      assert.equal(rows.length, 1);
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).before?.message, null);
      assert.equal(meta(rows[0]!).after?.message, 'Down for upgrades');
      assert.ok(meta(rows[0]!).after?.scheduledWindow, 'the window is part of the record');
    });

    it('a failed audit write leaves settings and windows as they were', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await refuseAuditWrites('maintenance_settings');
      const res = await as(admin, update('Down for upgrades'));
      assert.ok(res.statusCode >= 400, res.payload);
      assert.equal(await windows(), 0);
      assert.equal(await message(), null);
      assert.equal(await auditCount(), 0);
    });

    it('concurrent updates chain before → after', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const res = await Promise.all([
        as(admin, update('first', false)),
        as(admin, update('second', false)),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [200, 200],
      );
      const rows = await auditRows('maintenance_settings');
      assert.equal(rows.length, 2);
      const head = rows.find((r) => meta(r).before?.message === null)!;
      const tail = rows.find((r) => r !== head)!;
      assert.equal(meta(tail).before?.message, meta(head).after?.message);
      assert.equal(await message(), meta(tail).after?.message);
    });
  });

  // ──────────────────────────────────────────────────────── N2. app config ──
  describe('N2 app config', () => {
    async function snapshotAdminTheme() {
      const theme = await db().client.appTheme.findUnique({
        where: { appKey_colorScheme: { appKey: 'ADMIN', colorScheme: 'DARK' } },
      });
      const fonts = await db().client.appFont.findMany({ where: { appKey: 'ADMIN' } });
      restore.push(async () => {
        if (theme) {
          await db().client.appTheme.update({
            where: { id: theme.id },
            data: {
              tokens: theme.tokens ?? {},
              components: theme.components ?? {},
            },
          });
        } else {
          await db().client.appTheme.deleteMany({
            where: { appKey: 'ADMIN', colorScheme: 'DARK' },
          });
        }
        await db().client.appFont.deleteMany({ where: { appKey: 'ADMIN' } });
        if (fonts.length) {
          await db().client.appFont.createMany({
            data: fonts.map((f) => ({
              appKey: f.appKey,
              family: f.family,
              weight: f.weight,
              style: f.style,
              source: f.source,
              url: f.url,
              isActive: f.isActive,
            })),
          });
        }
        await db().client.appTranslation.deleteMany({ where: { key: { startsWith: 'audit.' } } });
        await db().client.appLocale.deleteMany({ where: { code: 'zz' } });
      });
    }
    const theme = (primary: string): InjectOptions => ({
      method: 'PUT',
      url: '/api/v1/admin/app-config/themes',
      payload: {
        app: 'admin',
        colorScheme: 'dark',
        tokens: { primary },
        actorId: SPOOFED_ACTOR_ID,
      },
    });
    const version = async () =>
      Number(
        (await db().client.systemSetting.findUnique({ where: { key: 'app_config.version' } }))
          ?.value ?? 1,
      );

    it('403 changes nothing and logs nothing', async () => {
      await snapshotAdminTheme();
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const before_ = await version();
      assert.equal((await as(support, theme('#123456'))).statusCode, 403);
      assert.equal(
        (await as(support, { method: 'POST', url: '/api/v1/admin/app-config/publish' })).statusCode,
        403,
      );
      assert.equal(await version(), before_);
      assert.equal(await auditCount(), 0);
    });

    it('theme, fonts, locale, translations, reset and publish each write one safe row', async () => {
      await snapshotAdminTheme();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const calls: Array<[string, InjectOptions]> = [
        ['app_theme', theme('#123456')],
        [
          'app_fonts',
          {
            method: 'PUT',
            url: '/api/v1/admin/app-config/fonts',
            payload: { app: 'admin', fonts: [{ family: 'Inter', weight: '400' }] },
          },
        ],
        [
          'app_locale',
          {
            method: 'POST',
            url: '/api/v1/admin/app-config/locales',
            payload: { code: 'zz', label: 'Test', nativeLabel: 'Test' },
          },
        ],
        [
          'app_translations',
          {
            method: 'PUT',
            url: '/api/v1/admin/app-config/translations',
            payload: {
              app: 'admin',
              locale: 'zz',
              entries: [{ key: 'audit.secret_copy', value: 'TERMS-TEXT-NOT-FOR-AUDIT' }],
            },
          },
        ],
        [
          'app_theme',
          {
            method: 'POST',
            url: '/api/v1/admin/app-config/reset',
            payload: { app: 'admin', colorScheme: 'dark' },
          },
        ],
        ['app_config', { method: 'POST', url: '/api/v1/admin/app-config/publish' }],
      ];
      const start = await version();
      for (const [, request] of calls) {
        const res = await as(admin, request);
        assert.ok(res.statusCode < 300, `${request.url}: ${res.payload}`);
      }
      assert.equal(await version(), start + calls.length, 'every write bumped the version once');
      const rows = await db().client.adminActivityLog.findMany({ orderBy: { createdAt: 'asc' } });
      assert.deepEqual(
        rows.map((r) => r.entityType),
        calls.map(([entity]) => entity),
      );
      for (const row of rows) assertActor(row, admin);
      const translation = rows.find((r) => r.entityType === 'app_translations')!;
      assert.deepEqual(meta(translation).after?.keys, ['audit.secret_copy']);
      assert.doesNotMatch(JSON.stringify(rows.map((r) => r.metadata)), /TERMS-TEXT-NOT-FOR-AUDIT/);
      // The PUT replaces the token set, so the row names every key it changed — including
      // the ones it removed — and none of their values.
      assert.ok((meta(rows[0]!).after?.changedTokens as string[]).includes('primary'));
      assert.doesNotMatch(JSON.stringify(meta(rows[0]!).after), /#123456/);
    });

    it('a failed audit write leaves the theme and the version unchanged', async () => {
      await snapshotAdminTheme();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const before_ = await version();
      const existing = await db().client.appTheme.findUnique({
        where: { appKey_colorScheme: { appKey: 'ADMIN', colorScheme: 'DARK' } },
      });
      await refuseAuditWrites('app_theme');
      const res = await as(admin, theme('#ABCDEF'));
      assert.ok(res.statusCode >= 400, res.payload);
      assert.equal(await version(), before_);
      const now = await db().client.appTheme.findUnique({
        where: { appKey_colorScheme: { appKey: 'ADMIN', colorScheme: 'DARK' } },
      });
      assert.deepEqual(now?.tokens ?? null, existing?.tokens ?? null);
    });

    it('concurrent publishes record distinct versions', async () => {
      await snapshotAdminTheme();
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const publish: InjectOptions = { method: 'POST', url: '/api/v1/admin/app-config/publish' };
      const res = await Promise.all([as(admin, publish), as(admin, publish)]);
      const versions = res.map((r) => r.json().data.version).sort();
      assert.equal(versions[1], versions[0] + 1, res.map((r) => r.payload).join('\n'));
      const rows = await auditRows('app_config');
      assert.deepEqual(rows.map((r) => meta(r).after?.version).sort(), versions);
    });
  });

  // ─────────────────────────────────────────────── N6. integration test sends ──
  describe('N6 integration test endpoints', () => {
    beforeEach(() => {
      restore.push(() =>
        db().client.systemSetting.deleteMany({
          where: { category: { in: ['integrations.sms', 'integrations.email'] } },
        }),
      );
    });
    const smsTest: InjectOptions = {
      method: 'POST',
      url: '/api/v1/admin/settings/integrations/sms/test',
      payload: { testPhone: '+919812345678', actorId: SPOOFED_ACTOR_ID },
    };

    it('403 never reaches the provider and logs nothing', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const res = await as(support, smsTest);
      assert.equal(res.statusCode, 403, res.payload);
      assert.equal(await auditCount(), 0);
    });

    it('a run is logged REQUESTED then SUCCESS, with the recipient masked', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const res = await as(admin, smsTest);
      assert.equal(res.statusCode, 200, res.payload);
      const rows = await auditRows('integration_test');
      assert.deepEqual(results(rows), ['REQUESTED', 'SUCCESS']);
      for (const row of rows) assertActor(row, admin);
      assert.equal(meta(rows[0]!).before?.recipient, '***5678');
      const text = JSON.stringify(rows.map((r) => r.metadata));
      assert.doesNotMatch(text, /9812345678|123456|apiKey|password/i);
    });

    it('a provider that reports failure is logged FAILED, never SUCCESS', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      // Airtel without credentials: the test runs and reports ok: false.
      await as(admin, {
        method: 'PUT',
        url: '/api/v1/admin/settings/integrations/sms',
        payload: { provider: 'airtel' },
      });
      const res = await as(admin, smsTest);
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().data.ok, false);
      assert.deepEqual(results(await auditRows('integration_test')), ['REQUESTED', 'FAILED']);
    });

    it('when the request cannot be logged, the provider is never called', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      await refuseAuditWrites('integration_test');
      const res = await as(admin, {
        method: 'POST',
        url: '/api/v1/admin/settings/integrations/email/test',
        payload: { testEmail: 'ops@example.com' },
      });
      assert.ok(res.statusCode >= 400, res.payload);
      assert.equal((await auditRows('integration_test')).length, 0);
    });
  });

  // ───────────────────────────────────────── fixes found by the final re-sweep ──
  describe('re-sweep fixes', () => {
    it('security policy: concurrent patches both land, and each row has a true before', async () => {
      restore.push(() => db().client.systemSetting.deleteMany({ where: { category: 'security' } }));
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const patch = (payload: Record<string, unknown>): InjectOptions => ({
        method: 'PUT',
        url: '/api/v1/admin/security/policy',
        payload: { ...payload, actorId: SPOOFED_ACTOR_ID },
      });
      const res = await Promise.all([
        as(admin, patch({ sessionTtlHours: 48 })),
        as(admin, patch({ passwordMinLength: 14 })),
      ]);
      assert.deepEqual(
        res.map((r) => r.statusCode),
        [200, 200],
      );
      const policy = await as(admin, { method: 'GET', url: '/api/v1/admin/security/policy' });
      const body = policy.json();
      const current = body.data ?? body;
      assert.equal(current.sessionTtlHours, 48, 'neither patch undid the other');
      assert.equal(current.passwordMinLength, 14);
      const rows = await auditRows('security_policy');
      assert.equal(rows.length, 2);
      for (const row of rows) assertActor(row, admin);
      const second = rows.find(
        (r) => meta(r).before?.sessionTtlHours === 48 || meta(r).before?.passwordMinLength === 14,
      );
      assert.ok(second, 'the later patch recorded the earlier one in its before');
    });

    it('session revoke: user session, refresh and audit row commit together, or not at all', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const target = await loginStaff(SUPPORT_PHONE, 'support');
      const adminSession = await db().client.adminSession.findFirstOrThrow({
        where: { userId: target.userId, revokedAt: null },
      });
      const revoke: InjectOptions = {
        method: 'POST',
        url: `/api/v1/admin/security/sessions/${adminSession.id}/revoke`,
        payload: { actorId: SPOOFED_ACTOR_ID },
      };
      const liveUserSessions = () =>
        db().client.userSession.count({
          where: { userId: target.userId, revokedAt: null, loginMethod: { startsWith: 'admin_' } },
        });
      assert.equal(await liveUserSessions(), 1);

      assert.equal((await as(target, revoke)).statusCode, 403, 'support lacks security:write');
      await refuseAuditWrites('admin_session');
      assert.ok((await as(admin, revoke)).statusCode >= 500);
      assert.equal(await liveUserSessions(), 1, 'the user session rolled back with the row');
      assert.equal(
        (await db().client.adminSession.findUniqueOrThrow({ where: { id: adminSession.id } }))
          .revokedAt,
        null,
      );
      assert.equal(await auditCount(), 0);

      await allowAuditWrites();
      assert.ok((await as(admin, revoke)).statusCode < 300);
      assert.equal(await liveUserSessions(), 0);
      assert.ok((await as(admin, revoke)).statusCode < 300, 'a repeat is harmless');
      const rows = await auditRows('admin_session', adminSession.id);
      assert.equal(rows.length, 1, 'and is not logged again');
      assertActor(rows[0]!, admin);
      assert.equal(meta(rows[0]!).after?.userSessionRevoked, true);
    });

    it('push retry: two concurrent retries send once; REQUESTED precedes the outcome', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const broadcast = await db().client.adminBroadcast.create({
        data: {
          title: 'Retry me',
          body: 'Body',
          channel: 'PUSH',
          targeting: { roles: ['customer'] },
          status: 'FAILED',
        },
      });
      const retry: InjectOptions = {
        method: 'POST',
        url: `/api/v1/admin/communications/push/${broadcast.id}/retry`,
      };
      const res = await Promise.all([as(admin, retry), as(admin, retry)]);
      assert.deepEqual(
        res.map((r) => r.statusCode).sort(),
        [200, 409],
        res.map((r) => r.payload).join('\n'),
      );
      const rows = await auditRows('admin_broadcast', broadcast.id);
      assert.deepEqual(results(rows), ['REQUESTED', 'FAILED'], 'no recipients: honestly FAILED');
      for (const row of rows) assertActor(row, admin);
    });

    it('incident and ticket rows carry classification, not location, evidence or description', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const reporter = await loginAs(app, CUSTOMER_PHONE);
      const incident = await as(admin, {
        method: 'POST',
        url: '/api/v1/admin/operations/incidents',
        payload: {
          type: 'MISCONDUCT',
          reporterUserId: reporter.userId,
          latitude: 34.0837,
          longitude: 74.7973,
          locationAddress: '12 Residency Road',
          description: 'PRIVATE ACCOUNT OF THE INCIDENT',
          evidenceFileIds: [randomUUID()],
        },
      });
      assert.equal(incident.statusCode, 201, incident.payload);
      const rows = await auditRows('safety_incident');
      assert.equal(rows.length, 1);
      assert.equal(meta(rows[0]!).after?.evidenceCount, 1);
      assert.doesNotMatch(
        JSON.stringify(rows[0]!.metadata),
        /34\.0837|74\.7973|Residency|PRIVATE ACCOUNT|evidenceFileIds/,
      );
    });
  });
});
