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

const ADMIN_PHONE = '+919876545402';
const ADMIN_EMAIL = 'dashboard-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

function formatIstWeekday(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(d);
}

describe('admin dashboard stats (integration)', () => {
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

  async function loginAdmin() {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return {
      authorization: `Bearer ${loggedIn.json().accessToken}`,
      adminUserId: seed.userId,
    };
  }

  async function seedDashboardFixture() {
    const customer = await loginAs(app, '+919876545403');
    const driverUser = await loginAs(app, '+919876545404');
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const driverId = await makeDriver(driverUser.userId, { verified: false });
    const vehicleId = await makeVehicle(vehicleTypeId);

    await db().client.vehicleAssignment.create({
      data: { driverId, vehicleId, status: 'ACTIVE' },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId, status: 'ONLINE', lastOnlineAt: new Date() },
    });

    const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
    await makeRide({
      requestId,
      customerId: customer.userId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status: 'IN_PROGRESS',
    });
  }

  it('returns dashboard stats for authorized admin users', async () => {
    const { authorization } = await loginAdmin();
    await seedDashboardFixture();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.equal(typeof body.stats.activeDrivers, 'number');
    assert.equal(typeof body.stats.activeRiders, 'number');
    assert.equal(typeof body.stats.ongoingRides, 'number');
    assert.equal(typeof body.stats.pendingVerifications, 'number');
    assert.ok(body.stats.activeDrivers >= 1);
    assert.ok(body.stats.ongoingRides >= 1);
    assert.ok(body.stats.pendingVerifications >= 1);
    assert.equal(Array.isArray(body.earningTrend), true);
    assert.equal(body.earningTrend.length, 7);
    for (const point of body.earningTrend) {
      assert.equal(typeof point.date, 'string');
      assert.equal(typeof point.earnings, 'number');
      assert.equal(typeof point.platformRevenue, 'number');
      assert.equal(typeof point.rideCommission, 'number');
      assert.equal(typeof point.subscriptionRevenue, 'number');
      assert.equal(typeof point.platformFees, 'number');
      assert.equal(typeof point.grossRideValue, 'number');
      assert.equal(typeof point.ridesCount, 'number');
    }
  });

  it('rejects unauthenticated requests', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
    });
    assert.equal(response.statusCode, 401);
  });

  it('Scenario 1: Customer ride fare (₹500) must NOT become platform revenue; only commission (₹50) is platform revenue', async () => {
    const { authorization } = await loginAdmin();
    const customer = await loginAs(app, '+919876545411');
    const driverUser = await loginAs(app, '+919876545412');
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const vehicleId = await makeVehicle(vehicleTypeId);

    const now = new Date();
    const reqId = await makeRideRequest(customer.userId, vehicleTypeId);
    const rideId = await makeRide({
      requestId: reqId,
      customerId: customer.userId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status: 'COMPLETED',
    });

    await db().client.ride.update({
      where: { id: rideId },
      data: { completedAt: now },
    });

    await db().client.rideFare.create({
      data: {
        rideId,
        currency: 'INR',
        baseFare: 50,
        distanceFare: 400,
        timeFare: 50,
        subtotal: 500,
        totalFare: 500,
        driverEarning: 450,
        platformCommission: 50,
      },
    });

    // Pinned commission of ₹50 posted to the double-entry ledger at completion
    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        amount: 50,
        currency: 'INR',
        referenceType: 'RIDE',
        referenceId: rideId,
        createdAt: now,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(response.statusCode, 200);
    const trend = response.json().earningTrend;
    const todayLabel = formatIstWeekday(now);
    const todayBucket = trend[trend.length - 1];

    assert.equal(todayBucket.date, todayLabel);
    // Platform revenue is strictly ₹50, NEVER ₹500
    assert.equal(todayBucket.platformRevenue, 50);
    assert.equal(todayBucket.earnings, 50);
    assert.equal(todayBucket.rideCommission, 50);
    // Gross ride value is the customer payment (₹500)
    assert.equal(todayBucket.grossRideValue, 500);
    assert.equal(todayBucket.ridesCount, 1);
    assert.notEqual(todayBucket.platformRevenue, 500);
  });

  it('Scenario 2: Driver subscription payment (₹199) is recognized as platform subscription revenue', async () => {
    const { authorization } = await loginAdmin();
    const now = new Date();

    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'CREDIT',
        amount: 199,
        currency: 'INR',
        referenceType: 'PAYMENT_INTENT',
        referenceId: randomUUID(),
        createdAt: now,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const todayBucket = res.json().earningTrend[res.json().earningTrend.length - 1];
    assert.equal(todayBucket.subscriptionRevenue, 199);
    assert.equal(todayBucket.platformRevenue, 199);
    assert.equal(todayBucket.earnings, 199);
  });

  it('Scenario 3: Commission wallet recharge (₹500) is a liability and NOT recognized as platform revenue', async () => {
    const { authorization } = await loginAdmin();
    const now = new Date();

    // Commission wallet recharge credits DRIVER_COMMISSION_WALLET (prepaid liability)
    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'DRIVER_COMMISSION_WALLET',
        direction: 'CREDIT',
        amount: 500,
        currency: 'INR',
        referenceType: 'PAYMENT_INTENT',
        referenceId: randomUUID(),
        createdAt: now,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const todayBucket = res.json().earningTrend[res.json().earningTrend.length - 1];
    assert.equal(todayBucket.platformRevenue, 0);
    assert.equal(todayBucket.earnings, 0);
    assert.equal(todayBucket.rideCommission, 0);
  });

  it('Scenario 4: Commission deduction of ₹30 from wallet is recognized as platform commission revenue', async () => {
    const { authorization } = await loginAdmin();
    const now = new Date();

    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        amount: 30,
        currency: 'INR',
        referenceType: 'RIDE',
        referenceId: randomUUID(),
        createdAt: now,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const todayBucket = res.json().earningTrend[res.json().earningTrend.length - 1];
    assert.equal(todayBucket.rideCommission, 30);
    assert.equal(todayBucket.platformRevenue, 30);
    assert.equal(todayBucket.earnings, 30);
  });

  it('Scenario 5: Refunded subscription reverses recognized subscription revenue', async () => {
    const { authorization } = await loginAdmin();
    const now = new Date();

    // 1. Subscription paid: CREDIT SUBSCRIPTION_REVENUE 199
    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'CREDIT',
        amount: 199,
        currency: 'INR',
        createdAt: now,
      },
    });

    // 2. Subscription refunded: DEBIT SUBSCRIPTION_REVENUE 199
    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'DEBIT',
        amount: 199,
        currency: 'INR',
        createdAt: now,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const todayBucket = res.json().earningTrend[res.json().earningTrend.length - 1];
    assert.equal(todayBucket.subscriptionRevenue, 0);
    assert.equal(todayBucket.platformRevenue, 0);
  });

  it('Scenario 6: Aggregates multiple revenue types (commission + subscription + fee) on the same day', async () => {
    const { authorization } = await loginAdmin();
    const now = new Date();

    await db().client.paymentLedgerEntry.createMany({
      data: [
        {
          entryGroup: randomUUID(),
          account: 'PLATFORM_COMMISSION',
          direction: 'CREDIT',
          amount: 40,
          currency: 'INR',
          createdAt: now,
        },
        {
          entryGroup: randomUUID(),
          account: 'SUBSCRIPTION_REVENUE',
          direction: 'CREDIT',
          amount: 199,
          currency: 'INR',
          createdAt: now,
        },
        {
          entryGroup: randomUUID(),
          account: 'PLATFORM_FEE',
          direction: 'CREDIT',
          amount: 15,
          currency: 'INR',
          createdAt: now,
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const todayBucket = res.json().earningTrend[res.json().earningTrend.length - 1];
    assert.equal(todayBucket.rideCommission, 40);
    assert.equal(todayBucket.subscriptionRevenue, 199);
    assert.equal(todayBucket.platformFees, 15);
    assert.equal(todayBucket.platformRevenue, 254);
    assert.equal(todayBucket.earnings, 254);
  });

  it('Scenario 7: Accurately separates revenue across multiple calendar days', async () => {
    const { authorization } = await loginAdmin();
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    await db().client.paymentLedgerEntry.createMany({
      data: [
        {
          entryGroup: randomUUID(),
          account: 'PLATFORM_COMMISSION',
          direction: 'CREDIT',
          amount: 75,
          currency: 'INR',
          createdAt: yesterday,
        },
        {
          entryGroup: randomUUID(),
          account: 'SUBSCRIPTION_REVENUE',
          direction: 'CREDIT',
          amount: 300,
          currency: 'INR',
          createdAt: today,
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const trend = res.json().earningTrend;
    const yesterdayBucket = trend[trend.length - 2];
    const todayBucket = trend[trend.length - 1];

    assert.equal(yesterdayBucket.platformRevenue, 75);
    assert.equal(yesterdayBucket.rideCommission, 75);
    assert.equal(yesterdayBucket.subscriptionRevenue, 0);

    assert.equal(todayBucket.platformRevenue, 300);
    assert.equal(todayBucket.subscriptionRevenue, 300);
    assert.equal(todayBucket.rideCommission, 0);
  });

  it('Scenario 8: Respects Asia/Kolkata timezone so 11:30 PM IST (18:00 UTC) belongs to the correct IST day', async () => {
    const { authorization } = await loginAdmin();
    // 18:00:00 UTC is 23:30:00 IST (same day in IST, but in UTC it is 18:00)
    const eveningUtc = new Date(Date.UTC(2026, 8, 25, 18, 0, 0)); // 25 Sept 2026 18:00 UTC = 25 Sept 2026 23:30 IST

    await db().client.paymentLedgerEntry.create({
      data: {
        entryGroup: randomUUID(),
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        amount: 85,
        currency: 'INR',
        createdAt: eveningUtc,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const trend = res.json().earningTrend;
    // Find the bucket matching the IST date for 25 Sept 2026
    const expectedWeekday = formatIstWeekday(eveningUtc);
    const matchingBucket = trend.find(
      (b: { date: string; platformRevenue: number }) =>
        b.date === expectedWeekday && b.platformRevenue === 85,
    );
    assert.ok(matchingBucket, 'Expected revenue to be bucketed under the matching IST weekday');
    assert.equal(matchingBucket.platformRevenue, 85);
  });

  it('Scenario 9: Returns 7 zero-filled days when no revenue data exists', async () => {
    const { authorization } = await loginAdmin();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const trend = res.json().earningTrend;
    assert.equal(trend.length, 7);
    for (const point of trend) {
      assert.equal(point.platformRevenue, 0);
      assert.equal(point.earnings, 0);
      assert.equal(point.rideCommission, 0);
      assert.equal(point.subscriptionRevenue, 0);
      assert.equal(point.platformFees, 0);
      assert.equal(point.grossRideValue, 0);
      assert.equal(point.ridesCount, 0);
    }
  });

  it('Scenario 10: Failed payment without ledger entry does not generate revenue', async () => {
    const { authorization } = await loginAdmin();
    const customer = await loginAs(app, '+919876545415');

    // A failed PaymentIntent in the payment_intents table
    await db().client.paymentIntent.create({
      data: {
        userId: customer.userId,
        amount: 199,
        currency: 'INR',
        methodType: 'CARD',
        status: 'FAILED',
        idempotencyKey: randomUUID(),
        purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(res.statusCode, 200);
    const trend = res.json().earningTrend;
    const totalRev = trend.reduce(
      (sum: number, p: { platformRevenue: number }) => sum + p.platformRevenue,
      0,
    );
    assert.equal(totalRev, 0, 'Failed payment intent must not generate revenue');
  });
});
