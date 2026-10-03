import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  grantRole,
  makeDriver,
  makeRide,
  makeRideRequest,
  makeVehicle,
  vehicleTypeIdByCode,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545101';
const ADMIN_EMAIL = 'admin-rbac@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

const FINANCE_PHONE = '+919876545102';
const FINANCE_EMAIL = 'finance-rbac@zaroorat.test';
const FINANCE_PASSWORD = 'Finance@12345';

const SUPER_PHONE = '+919876545103';
const SUPER_EMAIL = 'super-rbac@zaroorat.test';
const SUPER_PASSWORD = 'Super@12345';

const SUPPORT_PHONE = '+919876545108';
const SUPPORT_EMAIL = 'support-rbac@zaroorat.test';
const SUPPORT_PASSWORD = 'Support@12345';

const CUSTOMER_PHONE = '+919876545104';
const STRANGER_PHONE = '+919876545105';
const DRIVER1_PHONE = '+919876545106';
const DRIVER2_PHONE = '+919876545107';

describe('Production Security & RBAC Verification (Phase 4.5)', () => {
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
    await resetState();
  });

  async function createPrincipalWithRole(
    phone: string,
    email: string,
    password: string,
    roleSlug: 'admin' | 'finance' | 'support' | 'system_admin',
  ) {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, roleSlug);
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email,
        passwordHash: hashPassword(password),
        isEmailVerified: true,
      },
    });

    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password },
    });

    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return {
      authHeader: `Bearer ${loggedIn.json().accessToken}`,
      userId: seed.userId,
    };
  }

  // ─── 1. AUTHENTICATION BOUNDARY (401) ──────────────────────────────────────

  describe('1. Authentication Boundary Enforcement (401)', () => {
    it('rejects unauthenticated request to /dashboard/overview with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
      });
      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.ok(body.error?.code === 'TOKEN_INVALID' || body.error?.code === 'UNAUTHORIZED');
    });

    it('rejects unauthenticated request to /dashboard/financials with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/financials',
      });
      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.ok(body.error?.code === 'TOKEN_INVALID' || body.error?.code === 'UNAUTHORIZED');
    });

    it('rejects malformed bearer token with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
        headers: { authorization: 'Bearer invalid.token.payload' },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error?.code, 'TOKEN_INVALID');
    });
  });

  // ─── 2. PERMISSION BOUNDARY & STRICT 403 (NO ZERO / FAKE DATA) ─────────────

  describe('2. Permission Boundary & Strict 403 Enforcement', () => {
    it('refuses customer without operations:read on /dashboard/overview with 403', async () => {
      const customer = await loginAs(app, CUSTOMER_PHONE);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
        headers: { authorization: `Bearer ${customer.accessToken}` },
      });

      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error?.code, 'FORBIDDEN');
    });

    it('refuses operator without finance:read on /dashboard/financials with 403 (never 200 with zero revenue)', async () => {
      const support = await createPrincipalWithRole(
        SUPPORT_PHONE,
        SUPPORT_EMAIL,
        SUPPORT_PASSWORD,
        'support',
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/financials',
        headers: { authorization: support.authHeader },
      });

      // Crucial requirement: Must NOT return 200 with zero fallback data
      assert.equal(res.statusCode, 403, 'Must return 403 FORBIDDEN instead of fallback data');
      assert.equal(res.json().error?.code, 'FORBIDDEN');
    });

    it('allows admin with operations:read on /dashboard/overview with 200', async () => {
      const admin = await createPrincipalWithRole(
        ADMIN_PHONE,
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        'admin',
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
        headers: { authorization: admin.authHeader },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(typeof body.activeDrivers, 'number');
      assert.equal(typeof body.ongoingRides, 'number');
    });

    it('refuses finance without operations:read on /dashboard/overview with 403', async () => {
      const finance = await createPrincipalWithRole(
        FINANCE_PHONE,
        FINANCE_EMAIL,
        FINANCE_PASSWORD,
        'finance',
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
        headers: { authorization: finance.authHeader },
      });

      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error?.code, 'FORBIDDEN');
    });

    it('allows finance with finance:read on /dashboard/financials with 200', async () => {
      const finance = await createPrincipalWithRole(
        FINANCE_PHONE,
        FINANCE_EMAIL,
        FINANCE_PASSWORD,
        'finance',
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/financials',
        headers: { authorization: finance.authHeader },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(typeof body.platformRevenueToday, 'number');
      assert.equal(typeof body.grossRideValueToday, 'number');
    });

    it('allows system_admin full access to both overview and financials with 200', async () => {
      const superAdmin = await createPrincipalWithRole(
        SUPER_PHONE,
        SUPER_EMAIL,
        SUPER_PASSWORD,
        'system_admin',
      );

      const resOverview = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/overview',
        headers: { authorization: superAdmin.authHeader },
      });
      assert.equal(resOverview.statusCode, 200);

      const resFinancials = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/financials',
        headers: { authorization: superAdmin.authHeader },
      });
      assert.equal(resFinancials.statusCode, 200);
    });
  });

  // ─── 3. IDOR / BOLA CROSS-RESOURCE AUTHORIZATION ───────────────────────────

  describe('3. IDOR / BOLA Cross-Resource Authorization', () => {
    it('driver cannot access another driver wallet (returns 403 Forbidden)', async () => {
      const user1 = await loginAs(app, DRIVER1_PHONE);
      const driver1Id = await makeDriver(user1.userId);

      const user2 = await loginAs(app, DRIVER2_PHONE);
      await makeDriver(user2.userId);

      // Driver 2 attempts to query Driver 1's wallet
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/drivers/${driver1Id}/wallet`,
        headers: { authorization: `Bearer ${user2.accessToken}` },
      });

      assert.equal(
        res.statusCode,
        403,
        'Driver 2 must be forbidden from accessing Driver 1 wallet',
      );
      assert.equal(res.json().error?.code, 'FORBIDDEN');
    });

    it('driver can access their own driver wallet (returns 200)', async () => {
      const user1 = await loginAs(app, DRIVER1_PHONE);
      const driver1Id = await makeDriver(user1.userId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/drivers/${driver1Id}/wallet`,
        headers: { authorization: `Bearer ${user1.accessToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.json().data);
    });

    it('ops admin and system_admin can access any driver wallet for administrative oversight (returns 200)', async () => {
      const user1 = await loginAs(app, DRIVER1_PHONE);
      const driver1Id = await makeDriver(user1.userId);

      const admin = await createPrincipalWithRole(
        ADMIN_PHONE,
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        'admin',
      );
      const superAdmin = await createPrincipalWithRole(
        SUPER_PHONE,
        SUPER_EMAIL,
        SUPER_PASSWORD,
        'system_admin',
      );

      const adminRes = await app.inject({
        method: 'GET',
        url: `/api/v1/drivers/${driver1Id}/wallet`,
        headers: { authorization: admin.authHeader },
      });
      assert.equal(adminRes.statusCode, 200);

      const superRes = await app.inject({
        method: 'GET',
        url: `/api/v1/drivers/${driver1Id}/wallet`,
        headers: { authorization: superAdmin.authHeader },
      });
      assert.equal(superRes.statusCode, 200);
    });

    it('unrelated user cannot view ride payment details (returns 404 non-disclosure)', async () => {
      const rider = await loginAs(app, CUSTOMER_PHONE);
      const driverUser = await loginAs(app, DRIVER1_PHONE);
      const driverId = await makeDriver(driverUser.userId);
      const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(rider.userId, vehicleTypeId);

      const rideId = await makeRide({
        requestId,
        customerId: rider.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
      });

      const stranger = await loginAs(app, STRANGER_PHONE);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/rides/${rideId}/payment`,
        headers: { authorization: `Bearer ${stranger.accessToken}` },
      });

      // The platform returns 404 rather than 403 to prevent resource enumeration
      assert.equal(res.statusCode, 404, 'Stranger must receive 404 non-disclosure');
    });

    it('rider and admin can view ride payment details (returns 200)', async () => {
      const rider = await loginAs(app, CUSTOMER_PHONE);
      const driverUser = await loginAs(app, DRIVER1_PHONE);
      const driverId = await makeDriver(driverUser.userId);
      const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(rider.userId, vehicleTypeId);

      const rideId = await makeRide({
        requestId,
        customerId: rider.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
      });

      const riderRes = await app.inject({
        method: 'GET',
        url: `/api/v1/rides/${rideId}/payment`,
        headers: { authorization: `Bearer ${rider.accessToken}` },
      });
      assert.equal(riderRes.statusCode, 200);

      const admin = await createPrincipalWithRole(
        ADMIN_PHONE,
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        'admin',
      );
      const adminRes = await app.inject({
        method: 'GET',
        url: `/api/v1/rides/${rideId}/payment`,
        headers: { authorization: admin.authHeader },
      });
      assert.equal(adminRes.statusCode, 200);
    });
  });

  // ─── 4. AUDIT LOGGING FOR SENSITIVE ADMINISTRATIVE ACTIONS ─────────────────

  describe('4. Audit Logging for Sensitive Administrative Actions', () => {
    it('records actor, action, entityType, and metadata when an admin updates system configuration', async () => {
      const admin = await createPrincipalWithRole(
        ADMIN_PHONE,
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
        'admin',
      );
      await vehicleTypeIdByCode('CAB_ECONOMY');
      const nextYear = new Date().getFullYear() + 1;

      // 1. Create a fare rule
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/fare-rules',
        headers: { authorization: admin.authHeader },
        payload: {
          vehicleType: 'cab',
          cityCode: 'GLOBAL',
          baseFare: 55,
          minimumFare: 75,
          perKmRate: 14,
          perMinuteRate: 1.2,
          effectiveFrom: `${nextYear}-01-01`,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);

      // Verify that audit row was generated
      const auditRows = await db().client.adminActivityLog.findMany({
        where: {
          entityType: 'pricing_rule',
          actorId: admin.userId,
        },
        orderBy: { createdAt: 'desc' },
      });

      assert.ok(auditRows.length >= 1, 'Admin activity log entry must be created');
      const latest = auditRows[0];
      if (!latest) throw new Error('Expected at least one audit row');
      assert.equal(latest.actorId, admin.userId);
      assert.equal(latest.action, 'CREATE');
      assert.equal(latest.entityType, 'pricing_rule');
      assert.ok(latest.entityId);
      assert.ok(latest.createdAt);
    });

    it('writes zero audit entries when unauthorized mutation is attempted and rejected with 403', async () => {
      const finance = await createPrincipalWithRole(
        FINANCE_PHONE,
        FINANCE_EMAIL,
        FINANCE_PASSWORD,
        'finance',
      );
      await vehicleTypeIdByCode('CAB_ECONOMY');
      const nextYear = new Date().getFullYear() + 1;

      // Finance user does not have pricing:write permission
      const attempt = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/fare-rules',
        headers: { authorization: finance.authHeader },
        payload: {
          vehicleType: 'cab',
          cityCode: 'GLOBAL',
          baseFare: 99,
          minimumFare: 120,
          perKmRate: 20,
          perMinuteRate: 2,
          effectiveFrom: `${nextYear}-01-01`,
        },
      });

      assert.equal(attempt.statusCode, 403);

      // Verify NO audit log row was written for this unauthorized failure
      const auditRows = await db().client.adminActivityLog.findMany({
        where: {
          actorId: finance.userId,
          entityType: 'pricing_rule',
        },
      });
      assert.equal(auditRows.length, 0, 'No fake or corrupt audit row on forbidden rejection');
    });
  });
});
