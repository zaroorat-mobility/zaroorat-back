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
  makeVehicleType,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545301';
const ADMIN_EMAIL = 'ops-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const CUSTOMER_PHONE = '+919876545302';
const DRIVER_PHONE = '+919876545303';

describe('admin operations rides (integration)', () => {
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

  async function seedFullRideFixture() {
    const customer = await loginAs(app, CUSTOMER_PHONE);
    await db().client.userProfile.upsert({
      where: { userId: customer.userId },
      update: { firstName: 'Jane', lastName: 'Doe' },
      create: { userId: customer.userId, firstName: 'Jane', lastName: 'Doe' },
    });

    const driverUser = await loginAs(app, DRIVER_PHONE);
    await db().client.userProfile.upsert({
      where: { userId: driverUser.userId },
      update: { firstName: 'John', lastName: 'Driver' },
      create: { userId: driverUser.userId, firstName: 'John', lastName: 'Driver' },
    });

    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const vehicleTypeId = await makeVehicleType({ code: 'AUTO_OPS', name: 'Auto' });
    const vehicleId = await makeVehicle(vehicleTypeId);
    const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
    const rideId = await makeRide({
      requestId,
      customerId: customer.userId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status: 'IN_PROGRESS',
    });

    // Add status events
    await db().client.rideStatusEvent.createMany({
      data: [
        {
          rideId,
          fromStatus: null,
          toStatus: 'ACCEPTED',
          actorType: 'DRIVER',
          actorId: driverUser.userId,
          reason: 'Driver accepted ride',
        },
        {
          rideId,
          fromStatus: 'ACCEPTED',
          toStatus: 'IN_PROGRESS',
          actorType: 'DRIVER',
          actorId: driverUser.userId,
          reason: 'OTP verified and trip started',
        },
      ],
    });

    // Add fare and fare lines
    await db().client.rideFare.create({
      data: {
        rideId,
        currency: 'INR',
        baseFare: 50.0,
        distanceFare: 120.0,
        timeFare: 30.0,
        waitingCharge: 0.0,
        surgeMultiplier: 1.2,
        surgeAmount: 40.0,
        subtotal: 240.0,
        discountAmount: 20.0,
        taxAmount: 11.0,
        tollAmount: 0.0,
        platformFee: 15.0,
        tipAmount: 10.0,
        totalFare: 241.0,
        driverEarning: 200.0,
        platformCommission: 41.0,
      },
    });

    await db().client.rideFareLine.createMany({
      data: [
        { rideId, lineType: 'BASE_FARE', label: 'Base Fare', amount: 50.0, sequence: 1 },
        { rideId, lineType: 'DISTANCE_FARE', label: 'Distance Fare', amount: 120.0, sequence: 2 },
        { rideId, lineType: 'TIME_FARE', label: 'Time Fare', amount: 30.0, sequence: 3 },
        { rideId, lineType: 'SURGE', label: 'Surge Fare (1.2x)', amount: 40.0, sequence: 4 },
      ],
    });

    // Add driver location
    await db().client.$executeRawUnsafe(
      `INSERT INTO driver_locations
         (driver_id, latitude, longitude, location, heading, bearing, speed_kmh, accuracy_meters, is_mock_location, ride_id, recorded_at)
       VALUES ($1::uuid, 12.9716, 77.5946, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography, 90, 90, 35, 5, false, $2::uuid, now())
       ON CONFLICT (driver_id) DO UPDATE SET latitude = 12.9716, longitude = 77.5946`,
      driverId,
      rideId,
    );

    // Add payment
    await db().client.ridePayment.create({
      data: {
        rideId,
        amount: 241.0,
        method: 'CASH',
        status: 'PAID',
      },
    });

    return { customer, driverUser, driverId, vehicleId, vehicleTypeId, requestId, rideId };
  }

  it('rejects unauthenticated requests to operations rides', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/rides',
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects users without operations:read permission', async () => {
    const regularUser = await loginAs(app, '+919876545399');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/rides',
      headers: regularUser.authHeader,
    });
    assert.equal(res.statusCode, 403);
  });

  it('lists rides with pagination and filters for admin', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedFullRideFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/rides?page=1&limit=10',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.meta.page, 1);
    assert.ok(body.meta.total >= 1);
    assert.ok(Array.isArray(body.data));
    const found = body.data.find(
      (r: {
        id: string;
        status: string;
        customer: { name: string; phoneNumber: string };
        driver: { phoneNumber: string };
      }) => r.id === fixture.rideId,
    );
    assert.ok(found, 'Seeded ride should be in the list');
    assert.equal(found.status, 'IN_PROGRESS');
    assert.equal(found.customer.name, 'Jane Doe');
    assert.equal(found.customer.phoneNumber, CUSTOMER_PHONE);
    assert.equal(found.driver.phoneNumber, DRIVER_PHONE);
  });

  it('gets full ride details by id and by rideCode', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedFullRideFixture();

    const byIdRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(byIdRes.statusCode, 200, byIdRes.payload);
    const ride = byIdRes.json().data;
    assert.equal(ride.id, fixture.rideId);
    assert.equal(ride.status, 'IN_PROGRESS');
    assert.ok(ride.fareBreakdown);
    assert.equal(ride.fareBreakdown.totalFare, 241);
    assert.equal(ride.fareBreakdown.surgeAmount, 40);
    assert.equal(ride.timeline.length, 2);
    assert.equal(ride.payments.length, 1);

    const byCodeRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${ride.rideCode}`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(byCodeRes.statusCode, 200, byCodeRes.payload);
    assert.equal(byCodeRes.json().data.id, fixture.rideId);
  });

  it('returns 404 for non-existent ride', async () => {
    const authHeader = await loginAdmin();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${randomUUID()}`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(res.statusCode, 404, res.payload);
    assert.equal(res.json().error.code, 'RIDE_NOT_FOUND');
  });

  it('gets ride timeline', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedFullRideFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/timeline`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const timeline = res.json().data;
    assert.ok(Array.isArray(timeline));
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].toStatus, 'ACCEPTED');
    assert.equal(timeline[1].toStatus, 'IN_PROGRESS');
  });

  it('gets ride fare breakdown', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedFullRideFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/fare-breakdown`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const fare = res.json().data;
    assert.equal(fare.baseFare, 50);
    assert.equal(fare.surgeAmount, 40);
    assert.equal(fare.lines.length, 4);
  });

  it('gets ride payments and driver location', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedFullRideFixture();

    const paymentsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/payments`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(paymentsRes.statusCode, 200, paymentsRes.payload);
    assert.equal(paymentsRes.json().data.totalPaid, 241);

    const locationRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/driver-location`,
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(locationRes.statusCode, 200, locationRes.payload);
    assert.equal(locationRes.json().data.latitude, 12.9716);
    assert.equal(locationRes.json().data.longitude, 77.5946);
    assert.equal(locationRes.json().data.isLive, true);
  });

  it('exports rides as CSV', async () => {
    const authHeader = await loginAdmin();
    await seedFullRideFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/rides/export',
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.ok(res.headers['content-type']?.toString().includes('text/csv'));
    assert.ok(res.payload.includes('Ride Code,Booking Time,Status'));
    assert.ok(res.payload.includes('Jane Doe'));
  });
});
