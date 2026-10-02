import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
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

const ADMIN_PHONE = '+919876545601';
const ADMIN_EMAIL = 'admin-phase3@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

const SUPPORT_PHONE = '+919876545602';
const SUPPORT_EMAIL = 'support-phase3@zaroorat.test';
const SUPPORT_PASSWORD = 'Support@12345';

const FINANCE_PHONE = '+919876545603';
const FINANCE_EMAIL = 'finance-phase3@zaroorat.test';
const FINANCE_PASSWORD = 'Finance@12345';

describe('Admin Dashboard Phase 3 — Analytics, Live Drivers, Activity & Health (Integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
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

  // ─── PART 1: ANALYTICS API TESTS ──────────────────────────────────────────

  it('1. Analytics: returns zero-filled time buckets for empty database (7d, 30d, 90d)', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    // Today's operational analytics: 24 zero-filled hours, empty distribution, no financial series
    const resOps = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/analytics',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resOps.statusCode, 200, resOps.payload);
    const ops = resOps.json();
    assert.equal(ops.ridesByHour.length, 24, '24 hours returned');
    assert.equal(ops.rideStatusDistribution.total, 0);
    assert.equal(ops.rideStatusDistribution.noDriversFound, 0);
    assert.equal(ops.reportingTimeZone, 'Asia/Kolkata');
    assert.ok(ops.periodStart && ops.periodEnd);
    assert.equal(
      ops.platformRevenueTrend,
      undefined,
      'no financial series on the operations endpoint',
    );
    assert.equal(
      ops.grossRideValueTrend,
      undefined,
      'no financial series on the operations endpoint',
    );

    // 7-day range (default)
    const res7d = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics?range=7d',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(res7d.statusCode, 200, res7d.payload);
    const body7d = res7d.json();
    assert.equal(body7d.range, '7d');
    assert.equal(body7d.platformRevenueTrend.length, 7, '7 days returned');
    assert.equal(body7d.grossRideValueTrend.length, 7, '7 days returned');
    assert.equal(body7d.reportingTimeZone, 'Asia/Kolkata');

    // 30-day range
    const res30d = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics?range=30d',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(res30d.statusCode, 200);
    const body30d = res30d.json();
    assert.equal(body30d.platformRevenueTrend.length, 30, '30 days returned');
    assert.equal(body30d.grossRideValueTrend.length, 30, '30 days returned');

    // 90-day range
    const res90d = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics?range=90d',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(res90d.statusCode, 200);
    const body90d = res90d.json();
    assert.equal(body90d.platformRevenueTrend.length, 90, '90 days returned');

    // Invalid range rejected with 400
    const resInvalid = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics?range=1year',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resInvalid.statusCode, 400);
  });

  it('2. Analytics: accurate platform revenue, gross ride value, and hourly distribution', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const now = new Date();
    const todayIstStr = formatIstDate(now);
    const todayMidnight = new Date(`${todayIstStr}T00:00:00+05:30`);
    const todayAt = new Date(todayMidnight.getTime() + 14 * 60 * 60 * 1000); // 2:00 PM IST (Hour 14)

    // Completed Ride with fare ₹1,500
    const cust = await loginAs(app, '+919876546111');
    const dUser = await loginAs(app, '+919876546112');
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
      UPDATE "rides" SET "created_at" = ${todayAt}, "completed_at" = ${todayAt} WHERE "id" = ${rId}::uuid
    `;

    await db().client.rideFare.create({
      data: {
        rideId: rId,
        currency: 'INR',
        baseFare: 300,
        distanceFare: 900,
        timeFare: 300,
        subtotal: 1500,
        totalFare: 1500,
        driverEarning: 1320,
        platformCommission: 150,
      },
    });

    // Ledger entries today:
    // PLATFORM_COMMISSION: 150
    // PLATFORM_FEE: 30
    // SUBSCRIPTION_REVENUE: 299
    const eg = randomUUID();
    await db().client.paymentLedgerEntry.createMany({
      data: [
        {
          entryGroup: eg,
          account: 'PLATFORM_COMMISSION',
          direction: 'CREDIT',
          amount: 150,
          createdAt: todayAt,
        },
        {
          entryGroup: eg,
          account: 'PLATFORM_FEE',
          direction: 'CREDIT',
          amount: 30,
          createdAt: todayAt,
        },
        {
          entryGroup: eg,
          account: 'SUBSCRIPTION_REVENUE',
          direction: 'CREDIT',
          amount: 299,
          createdAt: todayAt,
        },
      ],
    });

    // Financial series (finance:read)
    const resFin = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics?range=7d',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resFin.statusCode, 200, resFin.payload);
    const fin = resFin.json();

    // Today's operational analytics (operations:read)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/analytics',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    // Verify today point in platform revenue trend
    const todayPlatformPoint = fin.platformRevenueTrend.find(
      (p: { dateKey: string }) => p.dateKey === todayIstStr,
    );
    assert.ok(todayPlatformPoint, 'Today point exists');
    assert.equal(todayPlatformPoint.rideCommission, 150);
    assert.equal(todayPlatformPoint.platformFees, 30);
    assert.equal(todayPlatformPoint.subscriptionRevenue, 299);
    assert.equal(todayPlatformPoint.platformRevenue, 479); // 150 + 30 + 299

    // Verify today point in gross ride value trend
    const todayGrossPoint = fin.grossRideValueTrend.find(
      (p: { dateKey: string }) => p.dateKey === todayIstStr,
    );
    assert.ok(todayGrossPoint, 'Today gross point exists');
    assert.equal(todayGrossPoint.grossRideValue, 1500);
    assert.equal(todayGrossPoint.ridesCount, 1);

    // Verify ride status distribution
    assert.equal(body.rideStatusDistribution.total, 1);
    assert.equal(body.rideStatusDistribution.completed, 1);
    assert.equal(body.rideStatusDistribution.completedPct, 100);

    // Verify hourly distribution peak at hour 14 (2 PM)
    const hour14 = body.ridesByHour.find((h: { hour: number }) => h.hour === 14);
    assert.ok(hour14, 'Hour 14 bucket exists');
    assert.equal(hour14.count, 1);
    assert.equal(hour14.isPeak, true);
  });

  // ─── PART 2: LIVE DRIVERS API TESTS ───────────────────────────────────────

  it('3. Live Drivers: returns empty list when no drivers registered', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/live-drivers',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.totalDrivers, 0);
    assert.equal(body.onlineCount, 0);
    assert.deepEqual(body.drivers, []);
  });

  it('4. Live Drivers: returns online driver, active ride, and GPS freshness (LIVE vs STALE)', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const now = Date.now();
    const freshRecordedAt = new Date(now - 10 * 1000); // 10 seconds ago -> LIVE
    // Older than the dispatch staleness threshold (geoConfig.candidateStalenessSeconds, 120 s) -> STALE
    const staleRecordedAt = new Date(now - 180 * 1000);

    // Driver 1: ONLINE, Auto, Fresh GPS
    const d1User = await loginAs(app, '+919876546201');
    const d1Id = await makeDriver(d1User.userId);
    const vAutoTypeId = await vehicleTypeIdByCode('AUTO');
    const vAutoId = await makeVehicle(vAutoTypeId);

    await db().client.vehicleAssignment.create({
      data: {
        driverId: d1Id,
        vehicleId: vAutoId,
        status: 'ACTIVE',
      },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId: d1Id, status: 'ONLINE' },
    });
    await db().client.$executeRaw`
      INSERT INTO "driver_locations" (
        "driver_id", "latitude", "longitude", "location", "heading", "speed_kmh", "recorded_at"
      ) VALUES (
        ${d1Id}::uuid, 12.9716, 77.5946, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326), 90.0, 35.0, ${freshRecordedAt}
      )
    `;

    // Driver 2: ON_TRIP, Car, Stale GPS, Active Ride
    const d2User = await loginAs(app, '+919876546202');
    const d2Id = await makeDriver(d2User.userId);
    const vCarTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
    const vCarId = await makeVehicle(vCarTypeId);

    await db().client.vehicleAssignment.create({
      data: {
        driverId: d2Id,
        vehicleId: vCarId,
        status: 'ACTIVE',
      },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId: d2Id, status: 'ON_TRIP' },
    });
    await db().client.$executeRaw`
      INSERT INTO "driver_locations" (
        "driver_id", "latitude", "longitude", "location", "heading", "speed_kmh", "recorded_at"
      ) VALUES (
        ${d2Id}::uuid, 12.9352, 77.6245, ST_SetSRID(ST_MakePoint(77.6245, 12.9352), 4326), 180.0, 42.0, ${staleRecordedAt}
      )
    `;

    // Create active ride for Driver 2
    const cust = await loginAs(app, '+919876546203');
    const reqId = await makeRideRequest(cust.userId, vCarTypeId);
    const rideId = await makeRide({
      requestId: reqId,
      customerId: cust.userId,
      driverId: d2Id,
      vehicleId: vCarId,
      vehicleTypeId: vCarTypeId,
      status: 'IN_PROGRESS',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/live-drivers',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.totalDrivers, 2);
    assert.equal(body.onlineCount, 1);
    assert.equal(body.onTripCount, 1);
    assert.equal(body.drivers.length, 2);

    const d1 = body.drivers.find((d: { id: string }) => d.id === d1Id);
    assert.ok(d1, 'Driver 1 returned');
    assert.equal(d1.mode, 'Auto');
    assert.equal(d1.status, 'ONLINE');
    assert.equal(d1.gpsFreshness, 'LIVE');
    assert.equal(d1.heading, 'E'); // 90 deg -> East
    assert.equal(d1.speedKmh, 35);
    assert.equal(d1.activeTrip, null);

    const d2 = body.drivers.find((d: { id: string }) => d.id === d2Id);
    assert.ok(d2, 'Driver 2 returned');
    assert.equal(d2.mode, 'Car');
    assert.equal(d2.status, 'ON_TRIP');
    assert.equal(d2.gpsFreshness, 'STALE');
    assert.equal(d2.heading, 'S'); // 180 deg -> South
    assert.ok(d2.activeTrip, 'Active trip populated');
    assert.equal(d2.activeTrip.id, rideId);
    assert.equal(d2.activeTrip.status, 'IN_PROGRESS');
  });

  it('5. Live Drivers: filters by viewport bounding box and mode', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const d1User = await loginAs(app, '+919876546211');
    const d1Id = await makeDriver(d1User.userId);
    const vAutoTypeId = await vehicleTypeIdByCode('AUTO');
    const vAutoId = await makeVehicle(vAutoTypeId);

    await db().client.vehicleAssignment.create({
      data: { driverId: d1Id, vehicleId: vAutoId, status: 'ACTIVE' },
    });
    // Live drivers are on-duty drivers
    await db().client.driverOnlineStatus.create({
      data: { driverId: d1Id, status: 'ONLINE' },
    });
    await db().client.$executeRaw`
      INSERT INTO "driver_locations" (
        "driver_id", "latitude", "longitude", "location", "heading", "speed_kmh", "recorded_at"
      ) VALUES (
        ${d1Id}::uuid, 12.9700, 77.5900, ST_SetSRID(ST_MakePoint(77.5900, 12.9700), 4326), 0.0, 20.0, NOW()
      )
    `;

    // Viewport containing 12.97, 77.59
    const resInside = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/live-drivers?viewport=12.90,77.50,13.00,77.60',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resInside.statusCode, 200);
    const bodyInside = resInside.json();
    assert.equal(bodyInside.drivers.length, 1);

    // Viewport outside (e.g. Delhi coords 28.6, 77.2)
    const resOutside = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/live-drivers?viewport=28.50,77.10,28.70,77.30',
      headers: { authorization: admin.authHeader },
    });
    assert.equal(resOutside.statusCode, 200);
    const bodyOutside = resOutside.json();
    assert.equal(bodyOutside.drivers.length, 0, 'No drivers in outside viewport');
  });

  // ─── PART 3: ACTIVITY API TESTS ───────────────────────────────────────────

  it('6. Activity: aggregates real operational events chronologically', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const cust = await loginAs(app, '+919876546301');
    const dUser = await loginAs(app, '+919876546302');
    const dId = await makeDriver(dUser.userId);
    const vTypeId = await vehicleTypeIdByCode('AUTO');
    const vId = await makeVehicle(vTypeId);

    // 1. New Driver registration event (past)
    await db().client.driver.update({
      where: { id: dId },
      data: { createdAt: new Date(Date.now() - 3600 * 1000) }, // 1 hr ago
    });

    // 2. Driver KYC verification event (30 mins ago)
    await db().client.driver.update({
      where: { id: dId },
      data: { approvedAt: new Date(Date.now() - 1800 * 1000) },
    });

    // 3. Completed Ride event (10 mins ago)
    const req1 = await makeRideRequest(cust.userId, vTypeId);
    const r1 = await makeRide({
      requestId: req1,
      customerId: cust.userId,
      driverId: dId,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'COMPLETED',
    });
    await db().client.rideStatusEvent.create({
      data: {
        rideId: r1,
        fromStatus: 'IN_PROGRESS',
        toStatus: 'COMPLETED',
        createdAt: new Date(Date.now() - 600 * 1000),
      },
    });

    // 4. Cancelled Ride event (2 mins ago - newest)
    const cust2 = await loginAs(app, '+919876546303');
    const req2 = await makeRideRequest(cust2.userId, vTypeId);
    const r2 = await makeRide({
      requestId: req2,
      customerId: cust2.userId,
      driverId: dId,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status: 'CANCELLED_BY_CUSTOMER',
    });
    await db().client.rideStatusEvent.create({
      data: {
        rideId: r2,
        fromStatus: 'ACCEPTED',
        toStatus: 'CANCELLED_BY_CUSTOMER',
        reason: 'Customer cancelled ride',
        createdAt: new Date(Date.now() - 120 * 1000),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/activity?limit=10',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.ok(body.activities.length >= 4, 'At least 4 events returned');

    // Verify newest is first
    assert.equal(body.activities[0].type, 'RIDE_CANCELLED');
    assert.equal(body.activities[1].type, 'RIDE_COMPLETED');
    assert.ok(body.activities.some((a: { type: string }) => a.type === 'KYC_APPROVED'));
    assert.ok(body.activities.some((a: { type: string }) => a.type === 'DRIVER_REGISTERED'));

    // Verify pagination limit works
    const resPaginated = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/activity?limit=2',
      headers: { authorization: admin.authHeader },
    });
    const bodyPaginated = resPaginated.json();
    assert.equal(bodyPaginated.activities.length, 2);
    assert.equal(bodyPaginated.hasMore, true);
  });

  // ─── PART 4: SYSTEM HEALTH API TESTS ──────────────────────────────────────

  it('7. Health: returns real system infrastructure status', async () => {
    const admin = await createPrincipalWithRole(ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, 'admin');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/health',
      headers: { authorization: admin.authHeader },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.databaseStatus, 'HEALTHY');
    assert.ok(body.databaseLatencyMs >= 0);
    assert.equal(body.apiLatencyMs, undefined, 'the metric is named for what it measures');
    assert.ok(['HEALTHY', 'DOWN'].includes(body.redisStatus));
    // Empty database: nothing to measure is NO_DATA with a null value, never a stand-in number
    assert.equal(body.gpsFreshnessStatus, 'NO_DATA');
    assert.equal(body.gpsFreshnessSec, null);
    assert.equal(body.notificationStatus, 'NO_DATA');
    assert.equal(body.notificationSuccessRate, null);
    assert.equal(body.paymentFailureStatus, 'NO_DATA');
    assert.equal(body.paymentFailureRate24h, null);
    assert.ok(['HEALTHY', 'DEGRADED', 'CRITICAL'].includes(body.overallStatus));
    assert.ok(body.timestamp);
  });

  // ─── PART 5: RBAC & SECURITY ──────────────────────────────────────────────

  it('8. RBAC: operations:read vs finance:read vs unauthenticated', async () => {
    // Unauthenticated request -> 401
    const resNoAuth = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/analytics',
    });
    assert.equal(resNoAuth.statusCode, 401);

    // Support role (has operations:read) -> Can access Analytics, Live Drivers, Activity, Health
    const support = await createPrincipalWithRole(
      SUPPORT_PHONE,
      SUPPORT_EMAIL,
      SUPPORT_PASSWORD,
      'support',
    );

    const resAnalytics = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/analytics',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resAnalytics.statusCode, 200);

    const resLiveDrivers = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/live-drivers',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resLiveDrivers.statusCode, 200);

    const resActivity = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/activity',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resActivity.statusCode, 200);

    const resHealth = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/health',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resHealth.statusCode, 200);

    // Finance role (has finance:read, but NOT operations:read) -> 403 Forbidden
    const finance = await createPrincipalWithRole(
      FINANCE_PHONE,
      FINANCE_EMAIL,
      FINANCE_PASSWORD,
      'finance',
    );

    const resFinanceBlocked = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/analytics',
      headers: { authorization: finance.authHeader },
    });
    assert.equal(resFinanceBlocked.statusCode, 403, 'Finance cannot read operations analytics');

    // Financial series are finance:read only
    assert.equal(
      resAnalytics.json().platformRevenueTrend,
      undefined,
      'support receives no revenue series',
    );
    const resSupportFin = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics',
      headers: { authorization: support.authHeader },
    });
    assert.equal(resSupportFin.statusCode, 403, 'Support cannot read financial analytics');
    const resFinanceFin = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/financial-analytics',
      headers: { authorization: finance.authHeader },
    });
    assert.equal(resFinanceFin.statusCode, 200, 'Finance can read financial analytics');
  });

  // ─── PART 6: EXPLAIN ANALYZE PERFORMANCE ──────────────────────────────────

  it('9. Performance: EXPLAIN ANALYZE on driver_locations.recorded_at index scan', async () => {
    const plans = await db().client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT MAX(recorded_at) FROM driver_locations;`,
    );

    console.warn('--- EXPLAIN ANALYZE: GPS FRESHNESS INDEX SCAN ---');
    plans.forEach((row) => console.warn(row['QUERY PLAN']));
    console.warn('------------------------------------------------');

    const planText = plans.map((p) => p['QUERY PLAN']).join('\n');
    assert.ok(
      planText.includes('Index Only Scan') ||
        planText.includes('Index Scan') ||
        planText.includes('Result'),
      'Uses index scan for MAX(recorded_at)',
    );
  });
});
