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

const ADMIN_PHONE = '+919876545401';
const ADMIN_EMAIL = 'ops-live-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin operations live dashboard (integration)', () => {
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

  async function seedLiveFixture() {
    const customerPhone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;
    const driverPhone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;

    const customer = await loginAs(app, customerPhone);
    await db().client.userProfile.upsert({
      where: { userId: customer.userId },
      update: { firstName: 'Alice', lastName: 'Customer' },
      create: { userId: customer.userId, firstName: 'Alice', lastName: 'Customer' },
    });

    const driverUser = await loginAs(app, driverPhone);
    await db().client.userProfile.upsert({
      where: { userId: driverUser.userId },
      update: { firstName: 'Bob', lastName: 'Driver' },
      create: { userId: driverUser.userId, firstName: 'Bob', lastName: 'Driver' },
    });

    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const driverId = await makeDriver(driverUser.userId, { isAvailable: true });
    const vehicleId = await makeVehicle(vehicleTypeId);

    await db().client.vehicleAssignment.create({
      data: {
        driverId,
        vehicleId,
        status: 'ACTIVE',
      },
    });

    await db().client.driverOnlineStatus.create({
      data: {
        driverId,
        status: 'ONLINE',
        lastOnlineAt: new Date(),
        batteryLevel: 88,
        appVersion: '1.2.0',
      },
    });

    const reqId = await makeRideRequest(customer.userId, vehicleTypeId, {
      status: 'MATCHED',
      pickupAddress: 'Lal Chowk, Srinagar',
      dropAddress: 'Dal Lake, Srinagar',
      surgeMultiplier: 1.0,
      quotedFare: 150,
    });

    const rideId = await makeRide({
      requestId: reqId,
      customerId: customer.userId,
      driverId,
      vehicleId,
      vehicleTypeId,
      rideCode: `R-LIVE-${randomUUID().slice(0, 4).toUpperCase()}`,
      status: 'IN_PROGRESS',
      paymentMethod: 'CASH',
      paymentStatus: 'PENDING',
      pickupAddress: 'Lal Chowk, Srinagar',
      dropAddress: 'Dal Lake, Srinagar',
      acceptedAt: new Date(Date.now() - 10 * 60 * 1000),
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const ride = await db().client.ride.findUnique({ where: { id: rideId } });

    await db().client.$executeRawUnsafe(
      `INSERT INTO driver_locations
         (driver_id, latitude, longitude, location, heading, speed_kmh, ride_id, recorded_at)
       VALUES ($1::uuid, 34.0837, 74.7973, ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography, 90, 35, $2::uuid, now())
       ON CONFLICT (driver_id) DO UPDATE SET
         latitude = 34.0837, longitude = 74.7973, location = ST_SetSRID(ST_MakePoint(74.7973, 34.0837), 4326)::geography,
         ride_id = $2::uuid, recorded_at = now()`,
      driverId,
      rideId,
    );

    return { customer, driverUser, driverId, vehicleId, ride, reqId };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/summary',
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects unauthorized users with 403', async () => {
    const regularUser = await loginAs(app, '+919876545499');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/summary',
      headers: regularUser.authHeader,
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns live summary KPIs for admin', async () => {
    const authHeader = await loginAdmin();
    await seedLiveFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/summary',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(typeof body.activeRidesCount, 'number');
    assert.equal(body.activeRidesCount >= 1, true);
    assert.equal(body.inProgressCount >= 1, true);
    assert.equal(typeof body.onlineDriversCount, 'number');
    assert.equal(typeof body.longWaitCount, 'number');
  });

  it('returns active rides list', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedLiveFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/active-rides',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data.length >= 1, true);
    const item = body.data.find((r) => r.id === fixture.ride?.id);
    assert.ok(item);
    assert.equal(item.status, 'IN_PROGRESS');
    assert.equal(item.customer.fullName, 'Alice Customer');
    assert.equal(item.driver.fullName, 'Bob Driver');
    assert.ok(item.driverLocation);
  });

  it('returns live map data with rides and drivers', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedLiveFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/map',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body.rides), true);
    assert.equal(Array.isArray(body.drivers), true);
    assert.equal(
      body.rides.some((r) => r.id === fixture.ride?.id),
      true,
    );
  });

  it('returns online driver fleet', async () => {
    const authHeader = await loginAdmin();
    await seedLiveFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/drivers',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data.length >= 1, true);
    const driver = body.data[0];
    assert.equal(driver.status, 'ONLINE');
    assert.ok(driver.location);
  });

  it('returns live alerts', async () => {
    const authHeader = await loginAdmin();
    await seedLiveFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/live/alerts?longWaitThresholdMin=1',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body), true);
  });
});
