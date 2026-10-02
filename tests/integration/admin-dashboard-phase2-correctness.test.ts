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
import { comparisonWindows } from '../../src/modules/admin/dashboard/dashboard.periods.js';

type Role = 'admin' | 'finance' | 'support' | 'system_admin';
const HOUR = 60 * 60 * 1000;

describe('Admin Dashboard Phase 2 — backend correctness (Integration)', () => {
  let app: FastifyInstance;
  let phoneSeq = 0;
  const nextPhone = () => `+9198765${String(47000 + phoneSeq++).padStart(5, '0')}`;

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

  async function principal(role: Role) {
    const seed = await loginAs(app, nextPhone());
    await grantRole(seed.userId, role);
    const email = `${role}-${randomUUID().slice(0, 8)}@zaroorat.test`;
    await db().client.user.update({
      where: { id: seed.userId },
      data: { email, passwordHash: hashPassword('Phase2@12345'), isEmailVerified: true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: 'Phase2@12345' },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return { authHeader: `Bearer ${res.json().accessToken}`, userId: seed.userId, email };
  }

  const get = (url: string, authHeader?: string) =>
    app.inject({ method: 'GET', url, headers: authHeader ? { authorization: authHeader } : {} });

  async function newDriver(options: Parameters<typeof makeDriver>[1] = {}) {
    const u = await loginAs(app, nextPhone());
    return makeDriver(u.userId, options);
  }

  async function newRide(driverId: string, status: string) {
    const cust = await loginAs(app, nextPhone());
    const vTypeId = await vehicleTypeIdByCode('AUTO');
    const vId = await makeVehicle(vTypeId);
    const reqId = await makeRideRequest(cust.userId, vTypeId);
    return makeRide({
      requestId: reqId,
      customerId: cust.userId,
      driverId,
      vehicleId: vId,
      vehicleTypeId: vTypeId,
      status,
    });
  }

  async function setLocation(
    driverId: string,
    recordedAt: Date,
    opts: { speed?: number | null; heading?: number | null } = {},
  ) {
    await db().client.$executeRaw`
      INSERT INTO "driver_locations" ("driver_id", "latitude", "longitude", "location", "heading", "speed_kmh", "recorded_at")
      VALUES (${driverId}::uuid, 12.9716, 77.5946, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326),
              ${opts.heading === undefined ? 90 : opts.heading}, ${opts.speed === undefined ? 30 : opts.speed}, ${recordedAt})
    `;
  }

  // ─── Overview comparisons ─────────────────────────────────────────────────

  it('overview: compares with the same time yesterday from shift logs and ride timestamps', async () => {
    const admin = await principal('admin');
    const x = comparisonWindows(new Date()).sameTimeYesterday;

    // Now: 2 drivers on duty, 1 ride ongoing
    const d1 = await newDriver();
    const d2 = await newDriver();
    await db().client.driverOnlineStatus.createMany({
      data: [
        { driverId: d1, status: 'ONLINE' },
        { driverId: d2, status: 'ON_TRIP' },
      ],
    });
    await newRide(d2, 'IN_PROGRESS');

    // Yesterday at X: d1 was on duty; d2's shift had already ended
    await db().client.driverShiftLog.createMany({
      data: [
        {
          driverId: d1,
          shiftStart: new Date(x.getTime() - HOUR),
          shiftEnd: new Date(x.getTime() + HOUR),
        },
        {
          driverId: d2,
          shiftStart: new Date(x.getTime() - 3 * HOUR),
          shiftEnd: new Date(x.getTime() - 2 * HOUR),
        },
      ],
    });

    // Yesterday at X: one ride was ongoing (completed after X), one had been cancelled before X
    const rOngoing = await newRide(d1, 'COMPLETED');
    const rCancelled = await newRide(d1, 'CANCELLED_BY_CUSTOMER');
    const before30 = new Date(x.getTime() - 30 * 60 * 1000);
    await db().client.$executeRaw`
      UPDATE "rides" SET "created_at" = ${before30}, "accepted_at" = ${before30},
        "completed_at" = ${new Date(x.getTime() + 10 * 60 * 1000)} WHERE "id" = ${rOngoing}::uuid`;
    await db().client.$executeRaw`
      UPDATE "rides" SET "created_at" = ${before30}, "accepted_at" = ${before30},
        "cancelled_at" = ${new Date(x.getTime() - 5 * 60 * 1000)} WHERE "id" = ${rCancelled}::uuid`;

    // A deleted driver pending verification is not counted anywhere
    const deleted = await newDriver({ verified: false });
    await db().client.driver.update({ where: { id: deleted }, data: { deletedAt: new Date() } });

    const res = await get('/api/v1/dashboard/overview', admin.authHeader);
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.equal(body.activeDrivers, 2);
    assert.equal(body.activeDriversChangePct, 100, '2 now vs 1 on duty at the same time yesterday');
    assert.equal(body.ongoingRides, 1);
    assert.equal(body.ongoingRidesChangePct, 0, '1 now vs 1 ongoing at the same time yesterday');
    assert.equal(body.pendingVerificationsChangePct, null, 'no verification history exists');
    assert.equal(body.registeredDrivers, 2, 'deleted drivers are not registered drivers');
    assert.equal(body.pendingVerifications, 0);
  });

  // ─── Financial date semantics ─────────────────────────────────────────────

  it('financials: ride legs follow the ride completion date, revenue follows posting date, negatives kept', async () => {
    const finance = await principal('finance');
    const w = comparisonWindows(new Date());
    const elapsed = w.now.getTime() - w.todayStart.getTime();
    const yesterdayBeforeCutoff = new Date(w.yesterdayStart.getTime() + elapsed / 2);
    const earlierToday = new Date(w.todayStart.getTime() + elapsed / 2);

    const driver = await newDriver();

    // Ride A: completed yesterday (before the cutoff), fare 1000. Its commission was
    // posted at completion; its platform fee only today, when the payment was collected.
    const rideA = await newRide(driver, 'COMPLETED');
    await db().client
      .$executeRaw`UPDATE "rides" SET "completed_at" = ${yesterdayBeforeCutoff} WHERE "id" = ${rideA}::uuid`;
    await db().client.rideFare.create({
      data: {
        rideId: rideA,
        currency: 'INR',
        baseFare: 1000,
        distanceFare: 0,
        timeFare: 0,
        subtotal: 1000,
        totalFare: 1000,
        driverEarning: 880,
        platformCommission: 100,
      },
    });

    // Ride B: completed today, fare 80, but a commission fixed at acceptance of 100.
    const rideB = await newRide(driver, 'COMPLETED');
    await db().client
      .$executeRaw`UPDATE "rides" SET "completed_at" = ${earlierToday} WHERE "id" = ${rideB}::uuid`;
    await db().client.rideFare.create({
      data: {
        rideId: rideB,
        currency: 'INR',
        baseFare: 80,
        distanceFare: 0,
        timeFare: 0,
        subtotal: 80,
        totalFare: 80,
        driverEarning: 0,
        platformCommission: 0,
      },
    });

    await db().client.paymentLedgerEntry.createMany({
      data: [
        {
          entryGroup: randomUUID(),
          account: 'PLATFORM_COMMISSION',
          direction: 'CREDIT',
          amount: 100,
          referenceType: 'RIDE',
          referenceId: rideA,
          createdAt: yesterdayBeforeCutoff,
        },
        {
          entryGroup: randomUUID(),
          account: 'PLATFORM_FEE',
          direction: 'CREDIT',
          amount: 20,
          referenceType: 'RIDE',
          referenceId: rideA,
          createdAt: earlierToday,
        },
        {
          entryGroup: randomUUID(),
          account: 'PLATFORM_COMMISSION',
          direction: 'CREDIT',
          amount: 100,
          referenceType: 'RIDE',
          referenceId: rideB,
          createdAt: earlierToday,
        },
      ],
    });

    const res = await get('/api/v1/dashboard/financials', finance.authHeader);
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    // Revenue: recognised on its posting date
    assert.equal(body.platformRevenueYesterday, 100, "ride A's commission, posted yesterday");
    assert.equal(
      body.platformRevenueToday,
      120,
      "ride A's fee + ride B's commission, both posted today",
    );
    // Ride value and collections: the ride's completion date, with all of its legs
    assert.equal(body.grossRideValueYesterday, 1000);
    assert.equal(
      body.driverRideCollectionsYesterday,
      880,
      'ride A: 1000 − 100 − 20, fee attributed to its ride',
    );
    assert.equal(body.grossRideValueToday, 80);
    assert.equal(
      body.driverRideCollectionsToday,
      -20,
      'ride B: 80 − 100, a real negative is preserved',
    );
    assert.equal(body.grossRideValueChangePct, -92);
  });

  // ─── RBAC ──────────────────────────────────────────────────────────────────

  it('financial analytics and legacy stats are finance data; operations analytics is not', async () => {
    const support = await principal('support');
    const finance = await principal('finance');
    const admin = await principal('admin');
    const superAdmin = await principal('system_admin');

    assert.equal((await get('/api/v1/dashboard/financial-analytics')).statusCode, 401);
    assert.equal(
      (await get('/api/v1/dashboard/financial-analytics', support.authHeader)).statusCode,
      403,
    );
    assert.equal(
      (await get('/api/v1/dashboard/financial-analytics', finance.authHeader)).statusCode,
      200,
    );
    assert.equal(
      (await get('/api/v1/dashboard/financial-analytics', admin.authHeader)).statusCode,
      200,
    );
    assert.equal(
      (await get('/api/v1/dashboard/financial-analytics', superAdmin.authHeader)).statusCode,
      200,
    );

    const ops = await get('/api/v1/dashboard/analytics', support.authHeader);
    assert.equal(ops.statusCode, 200);
    for (const key of ['platformRevenueTrend', 'grossRideValueTrend']) {
      assert.equal(ops.json()[key], undefined, `support must not receive ${key}`);
    }

    assert.equal(
      (await get('/api/v1/dashboard/stats', support.authHeader)).statusCode,
      403,
      'stats carries a revenue trend',
    );
    assert.equal(
      (await get('/api/v1/dashboard/stats', finance.authHeader)).statusCode,
      403,
      'stats also needs operations:read',
    );
    assert.equal((await get('/api/v1/dashboard/stats', admin.authHeader)).statusCode, 200);
  });

  // ─── Operations analytics: today, demand outcomes ─────────────────────────

  it('operations analytics covers today only and counts expired requests as no driver found', async () => {
    const admin = await principal('admin');
    const w = comparisonWindows(new Date());
    const earlierToday = new Date((w.todayStart.getTime() + w.now.getTime()) / 2);
    const yesterday = new Date(w.todayStart.getTime() - 2 * HOUR);
    const driver = await newDriver();

    const rToday = await newRide(driver, 'COMPLETED');
    await db().client
      .$executeRaw`UPDATE "rides" SET "created_at" = ${earlierToday} WHERE "id" = ${rToday}::uuid`;
    const rYesterday = await newRide(driver, 'COMPLETED');
    await db().client
      .$executeRaw`UPDATE "rides" SET "created_at" = ${yesterday} WHERE "id" = ${rYesterday}::uuid`;

    const vTypeId = await vehicleTypeIdByCode('AUTO');
    for (const [status, createdAt] of [
      ['EXPIRED', earlierToday],
      ['ABANDONED', earlierToday],
      ['EXPIRED', yesterday],
    ] as const) {
      const cust = await loginAs(app, nextPhone());
      const reqId = await makeRideRequest(cust.userId, vTypeId);
      await db().client.rideRequest.update({ where: { id: reqId }, data: { status, createdAt } });
    }

    const res = await get('/api/v1/dashboard/analytics', admin.authHeader);
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.rideStatusDistribution.completed, 1, "only today's ride");
    assert.equal(
      body.rideStatusDistribution.noDriversFound,
      1,
      "only today's expired request; abandoned is not 'no driver'",
    );
    assert.equal(body.rideStatusDistribution.total, 2);
    assert.equal(
      body.ridesByHour.reduce((s: number, h: { count: number }) => s + h.count, 0),
      1,
    );
    assert.equal(body.periodStart, w.todayStart.toISOString());
  });

  // ─── Live drivers ─────────────────────────────────────────────────────────

  it('live drivers: on-duty only, freshest first, real per-status counts, nulls for unknowns', async () => {
    const admin = await principal('admin');
    const now = Date.now();

    const autoType = await vehicleTypeIdByCode('AUTO');
    const fresh = await newDriver();
    await db().client.vehicleAssignment.create({
      data: { driverId: fresh, vehicleId: await makeVehicle(autoType), status: 'ACTIVE' },
    });
    await db().client.driverOnlineStatus.create({ data: { driverId: fresh, status: 'ONLINE' } });
    await setLocation(fresh, new Date(now - 10_000));

    const stale = await newDriver(); // no vehicle, fix without speed or heading
    await db().client.driverOnlineStatus.create({ data: { driverId: stale, status: 'BUSY' } });
    await setLocation(stale, new Date(now - 300_000), { speed: null, heading: null });

    const noFix = await newDriver();
    await db().client.driverOnlineStatus.create({ data: { driverId: noFix, status: 'BREAK' } });

    const offline = await newDriver();
    await db().client.driverOnlineStatus.create({ data: { driverId: offline, status: 'OFFLINE' } });
    await setLocation(offline, new Date(now - 86_400_000));

    const neverOnline = await newDriver();

    const deleted = await newDriver();
    await db().client.driverOnlineStatus.create({ data: { driverId: deleted, status: 'ONLINE' } });
    await db().client.driver.update({ where: { id: deleted }, data: { deletedAt: new Date() } });

    const res = await get('/api/v1/dashboard/live-drivers', admin.authHeader);
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();

    assert.deepEqual(
      body.drivers.map((d: { id: string }) => d.id),
      [fresh, stale, noFix],
      'on-duty drivers only, freshest fix first, no fix last',
    );
    assert.deepEqual(
      [
        body.onlineCount,
        body.onTripCount,
        body.busyCount,
        body.breakCount,
        body.offlineCount,
        body.totalDrivers,
      ],
      [1, 0, 1, 1, 2, 5],
      'offline includes never-online; deleted drivers excluded; counts sum to total',
    );
    assert.equal(body.idleCount, undefined, 'no derived idle count');

    const [f, s, n] = body.drivers;
    assert.equal(f.gpsFreshness, 'LIVE');
    assert.equal(f.mode, 'Auto');
    assert.equal(s.gpsFreshness, 'STALE');
    assert.ok(s.gpsLagSeconds > body.gpsStaleAfterSec);
    assert.equal(s.mode, null, 'no vehicle → no mode');
    assert.equal(s.speedKmh, null, 'unknown speed is null, not 0');
    assert.equal(s.heading, null);
    assert.equal(n.gpsFreshness, 'UNKNOWN');
    assert.equal(n.location, null);

    const off = (
      await get('/api/v1/dashboard/live-drivers?status=OFFLINE', admin.authHeader)
    ).json();
    assert.deepEqual(
      new Set(off.drivers.map((d: { id: string }) => d.id)),
      new Set([offline, neverOnline]),
    );
    assert.ok(off.drivers.every((d: { gpsFreshness: string }) => d.gpsFreshness === 'OFFLINE'));

    const autos = (await get('/api/v1/dashboard/live-drivers?mode=Auto', admin.authHeader)).json();
    assert.deepEqual(
      autos.drivers.map((d: { id: string }) => d.id),
      [fresh],
      'mode is filtered in the query',
    );
    const one = (await get('/api/v1/dashboard/live-drivers?limit=1', admin.authHeader)).json();
    assert.deepEqual(
      one.drivers.map((d: { id: string }) => d.id),
      [fresh],
    );
  });

  it('live drivers: invalid query parameters are 400, not 500', async () => {
    const admin = await principal('admin');
    for (const qs of [
      'limit=abc',
      'limit=0',
      'limit=201',
      'status=SLEEPING',
      'mode=Truck',
      'viewport=1,2,3',
      'viewport=91,0,92,1',
    ]) {
      const res = await get(`/api/v1/dashboard/live-drivers?${qs}`, admin.authHeader);
      assert.equal(res.statusCode, 400, `${qs}: ${res.payload}`);
      assert.equal(res.json().error.code, 'VALIDATION');
    }
  });

  // ─── Activity ─────────────────────────────────────────────────────────────

  it('activity: admin actions only with audit:read, and never their metadata or email', async () => {
    const admin = await principal('admin');
    const support = await principal('support');
    await db().client.adminActivityLog.create({
      data: {
        actorId: admin.userId,
        action: 'UPDATE',
        entityType: 'pricing',
        summary: 'Updated fare rule',
        metadata: { before: { secretField: 'old' }, after: { secretField: 'new' } },
      },
    });

    const asSupport = (
      await get('/api/v1/dashboard/activity?limit=100', support.authHeader)
    ).json();
    assert.ok(
      asSupport.activities.every((a: { type: string }) => a.type !== 'ADMIN_ACTION'),
      'support lacks audit:read',
    );
    const supportTyped = (
      await get('/api/v1/dashboard/activity?type=ADMIN_ACTION', support.authHeader)
    ).json();
    assert.deepEqual(supportTyped.activities, []);

    const asAdmin = (
      await get('/api/v1/dashboard/activity?type=ADMIN_ACTION', admin.authHeader)
    ).json();
    const item = asAdmin.activities.find(
      (a: { description: string }) => a.description === 'Updated fare rule',
    );
    assert.ok(item, 'admin (audit:read) sees admin actions');
    assert.equal(item.type, 'ADMIN_ACTION');
    assert.equal(item.metadata, undefined, 'no before/after state');
    assert.ok(!JSON.stringify(asAdmin).includes('secretField'));
    assert.ok(!JSON.stringify(asAdmin).includes(admin.email), 'no actor email');
  });

  it('activity: keyset pages through ties across sources without skips or duplicates', async () => {
    const admin = await principal('admin');
    const t = new Date(Date.now() - 60_000);
    const driver = await newDriver();
    await db().client.driver.update({
      where: { id: driver },
      data: { createdAt: t, approvedAt: t },
    });
    for (let i = 0; i < 3; i++) {
      const r = await newRide(driver, 'COMPLETED');
      await db().client.rideStatusEvent.create({
        data: { rideId: r, fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETED', createdAt: t },
      });
    }
    await db().client.adminActivityLog.create({
      data: { actorId: admin.userId, action: 'CREATE', summary: 'tie', createdAt: t },
    });

    const all = (await get('/api/v1/dashboard/activity?limit=100', admin.authHeader)).json();
    assert.equal(all.hasMore, false);
    assert.equal(all.nextCursor, null, 'last page has no cursor');
    const expected = all.activities.map((a: { id: string }) => a.id);
    assert.ok(
      expected.length >= 6,
      'three rides, a registration, a KYC approval and an admin action share one timestamp',
    );

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2';
      const page = (await get(`/api/v1/dashboard/activity?${qs}`, admin.authHeader)).json();
      assert.ok(page.activities.length <= 2);
      paged.push(...page.activities.map((a: { id: string }) => a.id));
      assert.equal(page.hasMore, page.nextCursor !== null);
      cursor = page.nextCursor;
    } while (cursor);

    assert.deepEqual(paged, expected, 'paging reproduces the full ordering exactly');

    const completedOnly = (
      await get('/api/v1/dashboard/activity?type=RIDE_COMPLETED&limit=2', admin.authHeader)
    ).json();
    assert.equal(completedOnly.activities.length, 2);
    assert.ok(completedOnly.activities.every((a: { type: string }) => a.type === 'RIDE_COMPLETED'));
    assert.equal(
      completedOnly.hasMore,
      true,
      'three completions exist, so a type-filtered page of 2 has more',
    );
  });

  it('activity: invalid cursor, type and limit are 400', async () => {
    const admin = await principal('admin');
    for (const qs of [
      'cursor=not-a-cursor',
      `cursor=${encodeURIComponent('2026-09-29T06:00:00.000Z')}`,
      'type=EVERYTHING',
      'limit=0',
      'limit=101',
    ]) {
      const res = await get(`/api/v1/dashboard/activity?${qs}`, admin.authHeader);
      assert.equal(res.statusCode, 400, `${qs}: ${res.payload}`);
    }
  });

  // ─── Health ───────────────────────────────────────────────────────────────

  it('health: GPS freshness reflects on-duty drivers only', async () => {
    const admin = await principal('admin');
    const d = await newDriver();
    await db().client.driverOnlineStatus.create({ data: { driverId: d, status: 'ONLINE' } });
    await setLocation(d, new Date(Date.now() - 5_000));
    const offline = await newDriver();
    await db().client.driverOnlineStatus.create({ data: { driverId: offline, status: 'OFFLINE' } });

    const body = (await get('/api/v1/dashboard/health', admin.authHeader)).json();
    assert.equal(body.gpsFreshnessStatus, 'LIVE');
    assert.ok(body.gpsFreshnessSec >= 0 && body.gpsFreshnessSec < 60);
  });
});
