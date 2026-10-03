import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import {
  allowAuditWrites,
  auditRows,
  refuseAuditWrites,
  SPOOFED_ACTOR_ID,
} from './helpers/audit.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876547001';
const SUPPORT_PHONE = '+919876547002';
const SUBJECT_PHONE = '+919876547003';
const PASSWORD = 'Admin@12345';
const USER_AGENT = 'audit-trail-test/1.0';
/// Cancellation policies are not in `resetState`'s TRUNCATE list, so this suite scopes
/// its own to a city code nothing else uses, and deletes them afterwards.
const POLICY_CITY = 'AUDT';

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

/// A mutation the admin surface exposes, described once so every case gets the same
/// four checks: 403 writes nothing, success writes exactly one row, a failed audit
/// write rolls the change back, and a body-supplied actor is ignored.
interface MutationCase {
  entityType: string;
  /// Seeds whatever the request depends on directly in the database, so no audit rows
  /// exist before the request under test.
  setup: (admin: Staff) => Promise<Record<string, string>>;
  create: (ctx: Record<string, string>) => InjectOptions;
  update: (id: string, ctx: Record<string, string>) => InjectOptions;
  /// Business rows of this kind — what must not change on 403 or rollback.
  count: () => Promise<number>;
  /// The field the update changes, and the value it is expected to hold afterwards.
  changed: [field: string, expected: unknown];
  /// Set when there is no create endpoint; the entity is seeded and only updated.
  seededId?: (ctx: Record<string, string>) => string;
}

const now = () => new Date();
const inThirtyDays = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

describe('admin audit trail (integration)', () => {
  let app: FastifyInstance;

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
    await db().client.cancellationPolicy.deleteMany({ where: { cityCode: POLICY_CITY } });
    await resetState();
  });

  async function loginStaff(phone: string, role: string): Promise<Staff> {
    const email = `${role}-${phone.slice(-4)}@audit.test`;
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

  async function me(user: LoggedInUser) {
    return app.inject({ method: 'GET', url: '/api/v1/users/me', headers: user.authHeader });
  }

  async function activeSessions(userId: string): Promise<number> {
    return db().client.userSession.count({ where: { userId, revokedAt: null } });
  }

  // ───────────────────────────────────────────────────────────── P1: drivers ──
  describe('driver moderation', () => {
    async function seedDriver() {
      const user = await loginAs(app, SUBJECT_PHONE);
      await grantRole(user.userId, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      return { user, driverId };
    }

    const suspend = (driverId: string, payload: Record<string, unknown> = {}) => ({
      method: 'POST' as const,
      url: `/api/v1/admin/drivers/${driverId}/suspend`,
      payload: { notes: 'Repeated no-shows', ...payload },
    });

    it('403: support cannot suspend — nothing changes, nothing is logged', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const { user, driverId } = await seedDriver();

      const res = await as(support, suspend(driverId));

      assert.equal(res.statusCode, 403, res.payload);
      const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(driver.isSuspended, false);
      assert.equal(
        (await db().client.user.findUniqueOrThrow({ where: { id: user.userId } })).status,
        'ACTIVE',
      );
      assert.equal(await db().client.adminActivityLog.count(), 0);
    });

    it('commits the suspension with exactly one audit row naming the authenticated actor', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { user, driverId } = await seedDriver();

      const res = await as(admin, suspend(driverId, { actorId: SPOOFED_ACTOR_ID }));

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(
        (await db().client.driver.findUniqueOrThrow({ where: { id: driverId } })).isSuspended,
        true,
      );
      assert.equal(await activeSessions(user.userId), 0, 'sessions revoked in the same commit');
      assert.equal((await me(user)).statusCode, 401, 'the epoch bump retired the access token');

      const rows = await auditRows('driver', driverId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'UPDATE');
      assertActor(rows[0]!, admin);
      const m = meta(rows[0]!);
      assert.equal(m.before?.status, 'active');
      assert.equal(m.before?.userStatus, 'ACTIVE');
      assert.equal(m.after?.status, 'suspended');
      assert.equal(m.after?.userStatus, 'SUSPENDED');
      assert.ok(Number(m.after?.sessionsRevoked) >= 1);
      assert.equal(m.notes, 'Repeated no-shows', 'the timeline still reads metadata.notes');
      assert.equal(m.result, 'SUCCESS');
    });

    it('rolls back the suspension and the session revocation when the audit write fails', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { user, driverId } = await seedDriver();
      const sessionsBefore = await activeSessions(user.userId);
      await refuseAuditWrites('driver');

      const res = await as(admin, suspend(driverId));

      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(driver.isSuspended, false);
      assert.equal(
        (await db().client.user.findUniqueOrThrow({ where: { id: user.userId } })).status,
        'ACTIVE',
      );
      assert.equal(await activeSessions(user.userId), sessionsBefore);
      assert.equal(
        await db().client.outboxEvent.count({ where: { aggregateId: driverId } }),
        0,
        'no suspension event escapes a rolled-back change',
      );
      assert.equal((await auditRows('driver', driverId)).length, 0);
      assert.equal((await me(user)).statusCode, 200, 'nothing committed, so no epoch bump');
    });

    it('logs one transition when two suspensions race', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const { driverId } = await seedDriver();

      const results = await Promise.all([
        as(admin, suspend(driverId)),
        as(admin, suspend(driverId)),
      ]);

      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      assert.equal((await auditRows('driver', driverId)).length, 1);
    });
  });

  // ────────────────────────────────────────────────────────────── P1: riders ──
  describe('rider moderation', () => {
    async function seedRider() {
      return loginAs(app, SUBJECT_PHONE);
    }

    const suspend = (riderId: string, payload: Record<string, unknown> = {}) => ({
      method: 'POST' as const,
      url: `/api/v1/admin/riders/${riderId}/suspend`,
      payload: { notes: 'Chargeback abuse', ...payload },
    });

    it('403: support cannot suspend — nothing changes, nothing is logged', async () => {
      const support = await loginStaff(SUPPORT_PHONE, 'support');
      const rider = await seedRider();

      const res = await as(support, suspend(rider.userId));

      assert.equal(res.statusCode, 403, res.payload);
      assert.equal(
        (await db().client.user.findUniqueOrThrow({ where: { id: rider.userId } })).status,
        'ACTIVE',
      );
      assert.equal(await db().client.adminActivityLog.count(), 0);
    });

    it('commits the suspension with exactly one audit row naming the authenticated actor', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const rider = await seedRider();

      const res = await as(admin, suspend(rider.userId, { actorId: SPOOFED_ACTOR_ID }));

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(
        (await db().client.user.findUniqueOrThrow({ where: { id: rider.userId } })).status,
        'SUSPENDED',
      );
      assert.equal(await activeSessions(rider.userId), 0);
      assert.equal((await me(rider)).statusCode, 401);

      const rows = await auditRows('rider', rider.userId);
      assert.equal(rows.length, 1);
      assertActor(rows[0]!, admin);
      const m = meta(rows[0]!);
      assert.equal(m.before?.status, 'active');
      assert.equal(m.after?.status, 'suspended');
      assert.equal(m.notes, 'Chargeback abuse');
    });

    it('rolls back the status change and the session revocation when the audit write fails', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const rider = await seedRider();
      const sessionsBefore = await activeSessions(rider.userId);
      await refuseAuditWrites('rider');

      const res = await as(admin, suspend(rider.userId));

      assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
      assert.equal(
        (await db().client.user.findUniqueOrThrow({ where: { id: rider.userId } })).status,
        'ACTIVE',
      );
      assert.equal(await activeSessions(rider.userId), sessionsBefore);
      assert.equal((await auditRows('rider', rider.userId)).length, 0);
      assert.equal((await me(rider)).statusCode, 200);
    });

    it('logs one transition when two suspensions race', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const rider = await seedRider();

      const results = await Promise.all([
        as(admin, suspend(rider.userId)),
        as(admin, suspend(rider.userId)),
      ]);

      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      assert.equal((await auditRows('rider', rider.userId)).length, 1);
    });
  });

  // ───────────────────────────────────────────────── P2: configuration surfaces ──
  async function seedPromotion(code = `P${randomUUID().slice(0, 8)}`): Promise<string> {
    const row = await db().client.promotion.create({
      data: {
        code,
        discountType: 'PERCENT',
        discountValue: 10,
        maxDiscount: 50,
        validFrom: now(),
        validTo: inThirtyDays(),
      },
    });
    return row.id;
  }

  async function seedProgram(): Promise<string> {
    const row = await db().client.referralProgram.create({
      data: { code: `R${randomUUID().slice(0, 8)}`, validFrom: now(), validTo: inThirtyDays() },
    });
    return row.id;
  }

  const cases: MutationCase[] = [
    {
      entityType: 'cancellation_policy',
      setup: async () => ({}),
      create: () => ({
        method: 'POST',
        url: '/api/v1/admin/cancellation-policies',
        payload: {
          actor: 'rider',
          scenario: 'after_assignment',
          chargeType: 'fixed',
          chargeAmount: 20,
          cityCode: POLICY_CITY,
        },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/cancellation-policies/${id}`,
        payload: { chargeAmount: 35 },
      }),
      count: () => db().client.cancellationPolicy.count({ where: { cityCode: POLICY_CITY } }),
      changed: ['feeAmount', '35'],
    },
    {
      entityType: 'promotion',
      setup: async () => ({}),
      create: () => ({
        method: 'POST',
        url: '/api/v1/admin/promotions',
        payload: {
          code: 'AUDIT20',
          discountType: 'PERCENT',
          discountValue: 20,
          maxDiscount: 50,
          validFrom: now().toISOString(),
          validTo: inThirtyDays().toISOString(),
        },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/promotions/${id}`,
        payload: { discountValue: 25 },
      }),
      count: () => db().client.promotion.count(),
      changed: ['discountValue', '25'],
    },
    {
      entityType: 'promo_campaign',
      setup: async () => ({}),
      create: () => ({
        method: 'POST',
        url: '/api/v1/admin/campaigns',
        payload: { name: 'Audit campaign' },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/campaigns/${id}`,
        payload: { name: 'Audit campaign v2' },
      }),
      count: () => db().client.promoCampaign.count(),
      changed: ['name', 'Audit campaign v2'],
    },
    {
      entityType: 'audience_segment',
      setup: async () => ({}),
      create: () => ({
        method: 'POST',
        url: '/api/v1/admin/segments',
        payload: { name: 'Audit segment' },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/segments/${id}`,
        payload: { name: 'Audit segment v2' },
      }),
      count: () => db().client.audienceSegment.count(),
      changed: ['name', 'Audit segment v2'],
    },
    {
      entityType: 'coupon_batch',
      setup: async () => ({ promotionId: await seedPromotion() }),
      create: (ctx) => ({
        method: 'POST',
        url: '/api/v1/admin/coupon-batches',
        payload: { promotionId: ctx.promotionId, totalCount: 3, generateNow: true },
      }),
      update: (id) => ({ method: 'POST', url: `/api/v1/admin/coupon-batches/${id}/deactivate` }),
      count: () => db().client.couponBatch.count(),
      changed: ['isActive', false],
    },
    {
      entityType: 'promo_banner',
      setup: async (admin) => {
        const at = now();
        const file = await db().client.file.create({
          data: {
            ownerUserId: admin.userId,
            purpose: 'PROMO_BANNER',
            status: 'READY',
            storageKey: `pb/test/${randomUUID()}.png`,
            storageProvider: 'mock',
            fileName: 'banner.png',
            contentType: 'image/png',
            detectedContentType: 'image/png',
            sizeBytes: 512,
            scanStatus: 'SKIPPED',
            uploadExpiresAt: at,
            uploadedAt: at,
            verifiedAt: at,
            completedAt: at,
            scannedAt: at,
          },
        });
        return { fileId: file.id };
      },
      create: (ctx) => ({
        method: 'POST',
        url: '/api/v1/admin/promo-banners',
        payload: { title: 'Audit banner', imageFileId: ctx.fileId },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/promo-banners/${id}`,
        payload: { title: 'Audit banner v2' },
      }),
      count: () => db().client.promoBanner.count(),
      changed: ['title', 'Audit banner v2'],
    },
    {
      entityType: 'referral_program',
      setup: async () => ({}),
      create: () => ({
        method: 'POST',
        url: '/api/v1/admin/referral-programs',
        payload: {
          name: 'Audit referral',
          qualifyingEvent: 'FIRST_RIDE',
          validFrom: now().toISOString(),
          validTo: inThirtyDays().toISOString(),
          isActive: true,
        },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/referral-programs/${id}`,
        payload: { maxReferralsPerUser: 20 },
      }),
      count: () => db().client.referralProgram.count(),
      changed: ['maxReferralsPerUser', 20],
    },
    {
      entityType: 'referral_milestone',
      setup: async () => ({ programId: await seedProgram() }),
      create: (ctx) => ({
        method: 'POST',
        url: `/api/v1/admin/referral-programs/${ctx.programId}/milestones`,
        payload: { name: 'Five friends', requiredReferrals: 5, bonusAmount: 0 },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/referral-milestones/${id}`,
        payload: { requiredReferrals: 6 },
      }),
      count: () => db().client.referralMilestone.count(),
      changed: ['requiredReferrals', 6],
    },
    {
      entityType: 'referral_code',
      setup: async () => {
        const owner = await loginAs(app, SUBJECT_PHONE);
        const code = await db().client.referralCode.create({
          data: { userId: owner.userId, programId: await seedProgram(), code: 'AUDITCODE' },
        });
        return { codeId: code.id };
      },
      seededId: (ctx) => ctx.codeId!,
      create: () => {
        throw new Error('referral codes are issued to users, not created by staff');
      },
      update: (id) => ({ method: 'POST', url: `/api/v1/admin/referral-codes/${id}/deactivate` }),
      count: () => db().client.referralCode.count({ where: { isActive: true } }),
      changed: ['isActive', false],
    },
    {
      entityType: 'invoice_template',
      setup: async () => ({}),
      create: () => ({
        method: 'POST',
        url: '/api/v1/admin/invoice-templates',
        payload: {
          name: 'Audit template',
          headerLogoText: 'Zaroorat',
          address: '1 Residency Road, Srinagar',
          gstin: '01ABCDE1234F1Z5',
          footerTerms: 'Thank you',
          appliesTo: 'school',
        },
      }),
      update: (id) => ({
        method: 'PATCH',
        url: `/api/v1/admin/invoice-templates/${id}`,
        payload: { name: 'Audit template v2' },
      }),
      count: () => db().client.invoiceTemplate.count({ where: { isActive: true } }),
      changed: ['name', 'Audit template v2'],
    },
  ];

  for (const c of cases) {
    describe(c.entityType, () => {
      const firstRequest = (ctx: Record<string, string>) =>
        c.seededId ? c.update(c.seededId(ctx), ctx) : c.create(ctx);
      const spoof = (request: InjectOptions): InjectOptions => ({
        ...request,
        payload: { ...((request.payload as object) ?? {}), actorId: SPOOFED_ACTOR_ID },
      });

      it('403: a staff role without the permission changes nothing and logs nothing', async () => {
        const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
        const support = await loginStaff(SUPPORT_PHONE, 'support');
        const ctx = await c.setup(admin);
        const countBefore = await c.count();

        const res = await as(support, firstRequest(ctx));

        assert.equal(res.statusCode, 403, res.payload);
        assert.equal(await c.count(), countBefore);
        assert.equal(await db().client.adminActivityLog.count(), 0);
      });

      it('writes exactly one audit row per change, with accurate before/after and the real actor', async () => {
        const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
        const ctx = await c.setup(admin);

        let id: string;
        if (c.seededId) {
          id = c.seededId(ctx);
        } else {
          const countBefore = await c.count();
          const created = await as(admin, spoof(c.create(ctx)));
          assert.equal(created.statusCode, 201, created.payload);
          assert.equal(await c.count(), countBefore + 1);
          id = created.json().data.id;
          const createRows = await auditRows(c.entityType, id);
          assert.equal(createRows.length, 1);
          assert.equal(createRows[0]!.action, 'CREATE');
          assertActor(createRows[0]!, admin);
          assert.ok(meta(createRows[0]!).after, 'CREATE records the new state');
          assert.equal(meta(createRows[0]!).before, undefined);
        }

        const updated = await as(admin, spoof(c.update(id, ctx)));
        assert.equal(updated.statusCode, 200, updated.payload);

        const updates = (await auditRows(c.entityType, id)).filter((r) => r.action === 'UPDATE');
        assert.equal(updates.length, 1);
        assertActor(updates[0]!, admin);
        const [field, expected] = c.changed;
        const m = meta(updates[0]!);
        assert.equal(m.after?.[field], expected);
        assert.notEqual(m.before?.[field], expected, 'before is the state the write replaced');
        assert.equal(m.result, 'SUCCESS');
      });

      it('rolls the change back when its audit row cannot be written', async () => {
        const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
        const ctx = await c.setup(admin);
        const countBefore = await c.count();
        await refuseAuditWrites(c.entityType);

        const res = await as(admin, firstRequest(ctx));

        assert.ok(res.statusCode >= 500, `${res.statusCode} ${res.payload}`);
        assert.equal(await c.count(), countBefore);
        assert.equal((await auditRows(c.entityType)).length, 0);
      });
    });
  }

  it('DELETE routes write one row carrying the state they removed', async () => {
    const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
    const deletions: Array<[entityType: string, path: string, action: 'DELETE' | 'UPDATE']> = [
      ['audience_segment', '/api/v1/admin/segments', 'DELETE'],
      ['promo_banner', '/api/v1/admin/promo-banners', 'DELETE'],
      ['invoice_template', '/api/v1/admin/invoice-templates', 'DELETE'],
      // Soft: a removed policy is deactivated, and logged as exactly that.
      ['cancellation_policy', '/api/v1/admin/cancellation-policies', 'UPDATE'],
    ];

    for (const [entityType, path, action] of deletions) {
      const c = cases.find((x) => x.entityType === entityType)!;
      const created = await as(admin, c.create(await c.setup(admin)));
      assert.equal(created.statusCode, 201, created.payload);
      const id = created.json().data.id as string;

      const removed = await as(admin, { method: 'DELETE', url: `${path}/${id}` });

      assert.equal(removed.statusCode, 200, `${entityType}: ${removed.payload}`);
      const rows = (await auditRows(entityType, id)).filter((r) => r.action === action);
      assert.equal(rows.length, 1, entityType);
      assertActor(rows[0]!, admin);
      assert.ok(meta(rows[0]!).before, `${entityType}: the removed state is kept`);
    }
  });

  describe('side effects on other rows are audited too', () => {
    it('activating a cancellation policy logs the one it retires', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const policy = {
        method: 'POST' as const,
        url: '/api/v1/admin/cancellation-policies',
        payload: {
          actor: 'driver',
          scenario: 'after_arrival',
          chargeType: 'fixed',
          chargeAmount: 10,
          cityCode: POLICY_CITY,
        },
      };
      const first = await as(admin, policy);
      const second = await as(admin, policy);
      assert.equal(first.statusCode, 201, first.payload);
      assert.equal(second.statusCode, 201, second.payload);

      const firstId = first.json().data.id;
      const retired = (await auditRows('cancellation_policy', firstId)).filter(
        (r) => r.action === 'UPDATE',
      );
      assert.equal(retired.length, 1);
      assert.equal(meta(retired[0]!).before?.isActive, true);
      assert.equal(meta(retired[0]!).after?.isActive, false);
      assert.equal(
        (await db().client.cancellationPolicy.findUniqueOrThrow({ where: { id: firstId } }))
          .isActive,
        false,
      );
    });

    it('activating a referral program logs the one it retires', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const program = (name: string) => ({
        method: 'POST' as const,
        url: '/api/v1/admin/referral-programs',
        payload: {
          name,
          qualifyingEvent: 'FIRST_RIDE',
          validFrom: now().toISOString(),
          validTo: inThirtyDays().toISOString(),
          isActive: true,
        },
      });
      const first = await as(admin, program('First'));
      const second = await as(admin, program('Second'));
      assert.equal(second.statusCode, 201, second.payload);

      const retired = (await auditRows('referral_program', first.json().data.id)).filter(
        (r) => r.action === 'UPDATE',
      );
      assert.equal(retired.length, 1);
      assert.equal(meta(retired[0]!).after?.isActive, false);
    });
  });

  describe('concurrent writes leave a consistent, non-duplicated trail', () => {
    it('two concurrent promotion edits chain before → after with no stale before', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const id = await seedPromotion('RACE10');
      const patch = (discountValue: number) => ({
        method: 'PATCH' as const,
        url: `/api/v1/admin/promotions/${id}`,
        payload: { discountValue },
      });

      const results = await Promise.all([as(admin, patch(30)), as(admin, patch(40))]);
      assert.deepEqual(
        results.map((r) => r.statusCode),
        [200, 200],
      );

      const rows = await auditRows('promotion', id);
      assert.equal(rows.length, 2);
      const first = rows.find((r) => meta(r).before?.discountValue === '10');
      assert.ok(first, 'one edit replaced the original value');
      const second = rows.find((r) => r !== first)!;
      assert.equal(
        meta(second).before?.discountValue,
        meta(first).after?.discountValue,
        'the second edit records the value the first one wrote, not a stale read',
      );
      const final = await db().client.promotion.findUniqueOrThrow({ where: { id } });
      assert.equal(final.discountValue.toString(), meta(second).after?.discountValue);
    });

    it('two concurrent coupon generations never pass the cap and log the true counts', async () => {
      const admin = await loginStaff(ADMIN_PHONE, 'system_admin');
      const promotionId = await seedPromotion();
      const created = await as(admin, {
        method: 'POST',
        url: '/api/v1/admin/coupon-batches',
        payload: { promotionId, totalCount: 3, generateNow: false },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const batchId = created.json().data.id;
      const generate = {
        method: 'POST' as const,
        url: `/api/v1/admin/coupon-batches/${batchId}/generate`,
        payload: { count: 2 },
      };

      const results = await Promise.all([as(admin, generate), as(admin, generate)]);
      assert.deepEqual(
        results.map((r) => r.statusCode),
        [200, 200],
      );

      assert.equal(await db().client.coupon.count({ where: { batchId } }), 3, 'cap of 3 holds');
      const counts = (await auditRows('coupon_batch', batchId))
        .filter((r) => r.action === 'UPDATE')
        .map((r) => [meta(r).before?.generatedCount, meta(r).after?.generatedCount])
        .sort();
      assert.deepEqual(counts, [
        [0, 2],
        [2, 3],
      ]);
    });
  });
});
