import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

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
import { formatIstDate } from '../../src/modules/admin/dashboard/dashboard.service.js';

const ADMIN_PHONE = '+919876545501';
const ADMIN_EMAIL = 'admin-phase2@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

const FINANCE_PHONE = '+919876545502';
const FINANCE_EMAIL = 'finance-phase2@zaroorat.test';
const FINANCE_PASSWORD = 'Finance@12345';

const SUPPORT_PHONE = '+919876545503';
const SUPPORT_EMAIL = 'support-phase2@zaroorat.test';
const SUPPORT_PASSWORD = 'Support@12345';

describe('Admin Dashboard Phase 2 — Overview & Financials (Integration)', () => {
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
    roleSlug: 'admin' | 'finance' | 'support',
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

  // ─── PART 1: OVERVIEW API TESTS ───────────────────────────────────────────

  it('1. Overview: returns empty zero state when database has no records', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.activeDrivers, 0);
    assert.equal(body.onlineDrivers, 0);
    assert.equal(body.onlineDriversPctOfActive, 0);
    assert.equal(body.ongoingRides, 0);
    assert.equal(body.inFlightRiders, 0);
    assert.equal(body.completedRidesToday, 0);
    assert.equal(body.completedRidesYesterday, 0);
    // No baseline yesterday → no percentage (null), never an invented 0 %
    assert.equal(body.completedRidesChangePct, null);
    assert.equal(body.activeDriversChangePct, null);
    assert.equal(body.ongoingRidesChangePct, null);
    assert.equal(body.pendingVerificationsChangePct, null);
    assert.equal(body.pendingVerifications, 0);
    assert.equal(body.registeredDrivers, 0);
    assert.ok(body.calculatedAt);
  });

  it('2. Overview: correctly aggregates driver statuses, active rides, and verifications', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    // Create 3 drivers with different online statuses and verifications
    const d1User = await loginAs(app, '+919876545111');
    const d1Id = await makeDriver(d1User.userId);
    await db().client.driver.update({
      where: { id: d1Id },
      data: { verificationStatus: 'PENDING' },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId: d1Id, status: 'ONLINE' },
    });

    const d2User = await loginAs(app, '+919876545112');
    const d2Id = await makeDriver(d2User.userId);
    await db().client.driver.update({
      where: { id: d2Id },
      data: { verificationStatus: 'DOCUMENT_REVIEW' },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId: d2Id, status: 'ON_TRIP' },
    });

    const d3User = await loginAs(app, '+919876545113');
    const d3Id = await makeDriver(d3User.userId);
    await db().client.driver.update({
      where: { id: d3Id },
      data: { verificationStatus: 'VERIFIED' },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId: d3Id, status: 'OFFLINE' },
    });

    // Create active ride
    const cust = await loginAs(app, '+919876545114');
    const vTypeId = await vehicleTypeIdByCode('AUTO');
    const vId = await makeVehicle(vTypeId);
    const reqId = await makeRideRequest(cust.userId, vTypeId);

    await makeRide({
      requestId: reqId,
      customerId: cust.userId,
      driverId: d2Id,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'IN_PROGRESS',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.registeredDrivers, 3, 'Total 3 drivers registered');
    assert.equal(body.activeDrivers, 2, 'ONLINE + ON_TRIP = 2 active drivers');
    assert.equal(body.onlineDrivers, 1, 'Only 1 ONLINE driver');
    assert.equal(body.onlineDriversPctOfActive, 50, '1/2 = 50% of active drivers are online');
    assert.equal(body.ongoingRides, 1, '1 ongoing ride in progress');
    assert.equal(body.inFlightRiders, 1, '1 unique in-flight rider');
    assert.equal(body.pendingVerifications, 2, '1 PENDING + 1 DOCUMENT_REVIEW = 2');
  });

  it('3. Overview: compares today so far with yesterday up to the same time and computes % change', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    // Positions relative to the current IST time of day, so the test holds at any hour.
    const now = new Date();
    const todayIstStr = formatIstDate(now);
    const todayMidnight = new Date(`${todayIstStr}T00:00:00+05:30`);
    const elapsed = now.getTime() - todayMidnight.getTime();
    const yesterdayMidnight = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);
    const todayCompletedAt = new Date(todayMidnight.getTime() + elapsed / 2); // earlier today
    const yesterdayCompletedAt = new Date(yesterdayMidnight.getTime() + elapsed / 2); // yesterday, before the cutoff
    // Yesterday but after the same-time cutoff: must not count as yesterday's baseline
    const yesterdayAfterCutoff = new Date(
      yesterdayMidnight.getTime() + elapsed + (24 * 60 * 60 * 1000 - elapsed) / 2,
    );

    const cust1 = await loginAs(app, '+919876545121');
    const cust2 = await loginAs(app, '+919876545122');
    const cust3 = await loginAs(app, '+919876545123');
    const cust4 = await loginAs(app, '+919876545127');
    const d1User = await loginAs(app, '+919876545124');
    const d2User = await loginAs(app, '+919876545125');
    const d3User = await loginAs(app, '+919876545126');

    const d1Id = await makeDriver(d1User.userId);
    const d2Id = await makeDriver(d2User.userId);
    const d3Id = await makeDriver(d3User.userId);

    const vTypeId = await vehicleTypeIdByCode('AUTO');
    const vId = await makeVehicle(vTypeId);

    // Ride 4: Completed yesterday after the cutoff (excluded from the comparison)
    const req4 = await makeRideRequest(cust4.userId, vTypeId);
    const r4Id = await makeRide({
      requestId: req4,
      customerId: cust4.userId,
      driverId: d1Id,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'COMPLETED',
    });
    await db().client.$executeRaw`
      UPDATE "rides" SET "completed_at" = ${yesterdayAfterCutoff} WHERE "id" = ${r4Id}::uuid
    `;

    // Ride 1: Completed yesterday before the cutoff
    const req1 = await makeRideRequest(cust1.userId, vTypeId);
    const r1Id = await makeRide({
      requestId: req1,
      customerId: cust1.userId,
      driverId: d1Id,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'COMPLETED',
    });
    await db().client.$executeRaw`
      UPDATE "rides" SET "completed_at" = ${yesterdayCompletedAt} WHERE "id" = ${r1Id}::uuid
    `;

    // Ride 2 & 3: Completed today (2 today vs 1 yesterday -> +100% change)
    const req2 = await makeRideRequest(cust2.userId, vTypeId);
    const r2Id = await makeRide({
      requestId: req2,
      customerId: cust2.userId,
      driverId: d2Id,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'COMPLETED',
    });
    await db().client.$executeRaw`
      UPDATE "rides" SET "completed_at" = ${todayCompletedAt} WHERE "id" = ${r2Id}::uuid
    `;

    const req3 = await makeRideRequest(cust3.userId, vTypeId);
    const r3Id = await makeRide({
      requestId: req3,
      customerId: cust3.userId,
      driverId: d3Id,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'COMPLETED',
    });
    await db().client.$executeRaw`
      UPDATE "rides" SET "completed_at" = ${todayCompletedAt} WHERE "id" = ${r3Id}::uuid
    `;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.completedRidesToday, 2, '2 rides completed today');
    assert.equal(
      body.completedRidesYesterday,
      1,
      '1 ride completed yesterday by this time (the later one excluded)',
    );
    assert.equal(body.completedRidesChangePct, 100, '(2 - 1)/1 * 100 = +100%');
  });

  // ─── PART 2: FINANCIALS API TESTS ─────────────────────────────────────────

  it('4. Financials: returns zero state when no financial ledger entries exist', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financials',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.platformRevenueToday, 0);
    assert.equal(body.platformRevenueYesterday, 0);
    assert.equal(body.platformRevenueChangePct, null);
    assert.equal(body.grossRideValueToday, 0);
    assert.equal(body.grossRideValueYesterday, 0);
    assert.equal(body.grossRideValueChangePct, null);
    assert.equal(body.driverRideCollectionsToday, 0);
    assert.equal(body.driverRideCollectionsYesterday, 0);
    assert.equal(body.driverRideCollectionsChangePct, null);
    assert.equal(body.currency, 'INR');
    assert.equal(body.reportingTimeZone, 'Asia/Kolkata');
    assert.ok(body.calculatedAt);
  });

  it('5. Financials: canonical calculation (Gross ₹1,000, Commission ₹100, Fee ₹20, Sub ₹199)', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const now = new Date();
    const todayIstStr = formatIstDate(now);
    const todayMidnight = new Date(`${todayIstStr}T00:00:00+05:30`);
    const todayAt = new Date((todayMidnight.getTime() + now.getTime()) / 2); // earlier today, whatever the hour

    // Completed Ride with fare ₹1,000
    const cust = await loginAs(app, '+919876545131');
    const dUser = await loginAs(app, '+919876545132');
    const dId = await makeDriver(dUser.userId);
    const vTypeId = await vehicleTypeIdByCode('AUTO');
    const vId = await makeVehicle(vTypeId);
    const reqId = await makeRideRequest(cust.userId, vTypeId);

    const rId = await makeRide({
      requestId: reqId,
      customerId: cust.userId,
      driverId: dId,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'COMPLETED',
    });
    await db().client.$executeRaw`
      UPDATE "rides" SET "completed_at" = ${todayAt} WHERE "id" = ${rId}::uuid
    `;

    await db().client.rideFare.create({
      data: {
        rideId: rId,
        currency: 'INR',
        baseFare: 200,
        distanceFare: 600,
        timeFare: 200,
        subtotal: 1000,
        totalFare: 1000,
        driverEarning: 880,
        platformCommission: 100,
      },
    });

    // Ledger entries today:
    // PLATFORM_COMMISSION: 100 (ride leg)
    // PLATFORM_FEE: 20 (ride leg)
    // SUBSCRIPTION_REVENUE: 199 (not a ride)
    // Ride legs carry the ride reference, as every real posting does (ledger.service.ts).
    const eg = randomUUID();
    await db().client.paymentLedgerEntry.createMany({
      data: [
        {
          entryGroup: eg,
          account: 'PLATFORM_COMMISSION',
          direction: 'CREDIT',
          amount: 100,
          referenceType: 'RIDE',
          referenceId: rId,
          createdAt: todayAt,
        },
        {
          entryGroup: eg,
          account: 'PLATFORM_FEE',
          direction: 'CREDIT',
          amount: 20,
          referenceType: 'RIDE',
          referenceId: rId,
          createdAt: todayAt,
        },
        {
          entryGroup: eg,
          account: 'SUBSCRIPTION_REVENUE',
          direction: 'CREDIT',
          amount: 199,
          createdAt: todayAt,
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financials',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.grossRideValueToday, 1000, 'Gross ride value is ₹1,000');
    assert.equal(
      body.platformRevenueToday,
      319,
      'Platform Revenue = Commission (100) + Fee (20) + Subscription (199) = 319',
    );
    assert.equal(
      body.driverRideCollectionsToday,
      880,
      'Driver Collections = Gross (1000) - Ride Deductions (100+20) = 880 (excl subscription)',
    );
  });

  // ─── PART 3: RBAC & AUTHORIZATION TESTS ───────────────────────────────────

  it('6. RBAC: unauthenticated request is rejected with 401', async () => {
    const resOverview = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
    });
    assert.equal(resOverview.statusCode, 401);

    const resFinancials = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financials',
    });
    assert.equal(resFinancials.statusCode, 401);
  });

  it('7. RBAC: support role has operations:read (can access overview, forbidden from financials 403)', async () => {
    const support = await createPrincipalWithRole(
      SUPPORT_PHONE,
      SUPPORT_EMAIL,
      SUPPORT_PASSWORD,
      'support',
    );

    // Can read overview
    const resOverview = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resOverview.statusCode, 200, resOverview.payload);

    // Forbidden from financials
    const resFinancials = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financials',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resFinancials.statusCode, 403, 'Support cannot read financials');
  });

  it('8. RBAC: finance role has finance:read (can access financials, forbidden from overview 403)', async () => {
    const finance = await createPrincipalWithRole(
      FINANCE_PHONE,
      FINANCE_EMAIL,
      FINANCE_PASSWORD,
      'finance',
    );

    // Can read financials
    const resFinancials = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financials',
      headers: { authorization: finance.authHeader },
    });
    assert.equal(resFinancials.statusCode, 200, resFinancials.payload);

    // Forbidden from overview
    const resOverview = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: { authorization: finance.authHeader },
    });
    assert.equal(resOverview.statusCode, 403, 'Finance cannot read overview');
  });

  it('9. RBAC: admin has both permissions and can access both endpoints', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const resOverview = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resOverview.statusCode, 200);

    const resFinancials = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financials',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resFinancials.statusCode, 200);
  });

  // ─── PART 4: BACKWARD COMPATIBILITY ───────────────────────────────────────

  it('10. Compatibility: existing /api/v1/dashboard/stats continues to return stats and earningTrend', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.ok(body.stats);
    assert.equal(typeof body.stats.activeDrivers, 'number');
    assert.equal(typeof body.stats.inFlightRiders, 'number');
    assert.equal(typeof body.stats.activeRiders, 'number');
    assert.equal(typeof body.stats.ongoingRides, 'number');
    assert.equal(typeof body.stats.pendingVerifications, 'number');
    assert.ok(Array.isArray(body.earningTrend));
  });

  // ─── PART 5: PERFORMANCE EXPLAIN ANALYZE ──────────────────────────────────

  it('11. Performance: EXPLAIN ANALYZE on overview completed rides query', async () => {
    const rows = await db().client.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT
        COUNT(*) FILTER (WHERE "completed_at" >= now() - interval '1 day' AND "completed_at" < now())::int AS today_completed,
        COUNT(*) FILTER (WHERE "completed_at" >= now() - interval '2 days' AND "completed_at" < now() - interval '1 day')::int AS yesterday_completed
      FROM "rides"
      WHERE "status" = 'COMPLETED'::"RideStatus"
        AND "completed_at" >= now() - interval '2 days'
        AND "completed_at" < now();
    `);

    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    console.warn('--- EXPLAIN ANALYZE: OVERVIEW COMPLETED RIDES QUERY ---');
    console.warn(plan);
    console.warn('-------------------------------------------------------');
    assert.ok(plan.length > 0);
  });

  it('12. Performance: EXPLAIN ANALYZE on financials ledger aggregation query', async () => {
    const rows = await db().client.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT
        CASE
          WHEN ple."created_at" >= now() - interval '1 day' THEN 'today'
          ELSE 'yesterday'
        END AS period,
        ple."account" AS account,
        ple."direction" AS direction,
        COALESCE(SUM(ple."amount"), 0) AS total
      FROM "payment_ledger_entries" ple
      WHERE ple."account" IN ('PLATFORM_COMMISSION', 'SUBSCRIPTION_REVENUE', 'PLATFORM_FEE')
        AND ple."created_at" >= now() - interval '2 days'
        AND ple."created_at" < now()
      GROUP BY 1, 2, 3;
    `);

    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    console.warn('--- EXPLAIN ANALYZE: FINANCIALS LEDGER QUERY ---');
    console.warn(plan);
    console.warn('------------------------------------------------');
    assert.ok(plan.length > 0);
  });
});
