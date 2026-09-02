import assert from 'node:assert/strict';
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
});
