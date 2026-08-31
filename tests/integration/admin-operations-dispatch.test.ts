import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  grantRole,
  makeDriver,
  makeRideRequest,
  makeVehicle,
  vehicleTypeIdByCode,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545501';
const ADMIN_EMAIL = 'ops-dispatch-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin operations dispatch console (integration)', () => {
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

  async function seedDispatchFixture() {
    const customerPhone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;
    const driver1Phone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;
    const driver2Phone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;

    const customer = await loginAs(app, customerPhone);
    await db().client.userProfile.upsert({
      where: { userId: customer.userId },
      update: { firstName: 'Diana', lastName: 'Customer' },
      create: { userId: customer.userId, firstName: 'Diana', lastName: 'Customer' },
    });

    const driver1User = await loginAs(app, driver1Phone);
    await db().client.userProfile.upsert({
      where: { userId: driver1User.userId },
      update: { firstName: 'Driver', lastName: 'One' },
      create: { userId: driver1User.userId, firstName: 'Driver', lastName: 'One' },
    });

    const driver2User = await loginAs(app, driver2Phone);
    await db().client.userProfile.upsert({
      where: { userId: driver2User.userId },
      update: { firstName: 'Driver', lastName: 'Two' },
      create: { userId: driver2User.userId, firstName: 'Driver', lastName: 'Two' },
    });

    const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
    const driver1Id = await makeDriver(driver1User.userId);
    const vehicle1Id = await makeVehicle(vehicleTypeId);
    const driver2Id = await makeDriver(driver2User.userId);
    const vehicle2Id = await makeVehicle(vehicleTypeId);

    const reqId = await makeRideRequest(customer.userId, vehicleTypeId);
    await db().client.rideRequest.update({
      where: { id: reqId },
      data: {
        pickupAddress: 'Kashmir University, Srinagar',
        dropAddress: 'Airport, Srinagar',
        surgeMultiplier: 1.2,
        quotedFare: 450,
      },
    });

    await db().client.rideDispatch.createMany({
      data: [
        {
          requestId: reqId,
          driverId: driver1Id,
          vehicleId: vehicle1Id,
          dispatchRound: 1,
          response: 'REJECTED',
          rejectReason: 'DISTANCE_TOO_FAR',
          driverDistanceM: 2500,
          driverEtaSeconds: 360,
          offeredAt: new Date(Date.now() - 3 * 60 * 1000),
          respondedAt: new Date(Date.now() - 2 * 60 * 1000),
        },
        {
          requestId: reqId,
          driverId: driver2Id,
          vehicleId: vehicle2Id,
          dispatchRound: 2,
          response: 'PENDING',
          driverDistanceM: 1200,
          driverEtaSeconds: 180,
          offeredAt: new Date(Date.now() - 1 * 60 * 1000),
          expiresAt: new Date(Date.now() + 2 * 60 * 1000),
        },
      ],
    });

    return { reqId, customer, driver1Id, driver2Id, vehicleTypeId };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/dispatch/requests',
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects unauthorized users with 403', async () => {
    const regularUser = await loginAs(app, '+919876545599');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/dispatch/requests',
      headers: regularUser.authHeader,
    });
    assert.equal(res.statusCode, 403);
  });

  it('lists dispatch requests with matching rounds count and filters', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedDispatchFixture();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/dispatch/requests?status=SEARCHING',
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body.data), true);
    const item = body.data.find((r: { id: string }) => r.id === fixture.reqId);
    assert.ok(item);
    assert.equal(item.status, 'SEARCHING');
    assert.equal(item.customerName, 'Diana Customer');
    assert.equal(item.dispatchRoundsCount, 2);
    assert.equal(item.totalOffersCount, 2);
    assert.equal(item.vehicleTypeCode, 'CAB_ECONOMY');
  });

  it('returns full dispatch request details with candidate list and summary', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedDispatchFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/dispatch/requests/${fixture.reqId}`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.id, fixture.reqId);
    assert.equal(body.customer.fullName, 'Diana Customer');
    assert.equal(body.summary.totalRounds, 2);
    assert.equal(body.summary.totalDispatches, 2);
    assert.equal(body.summary.rejectedCount, 1);
    assert.equal(body.summary.pendingCount, 1);
    assert.equal(body.candidates.length, 2);
    assert.equal(body.candidates[0].rejectReason, 'DISTANCE_TOO_FAR');
  });

  it('returns candidate breakdown for a request', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedDispatchFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/dispatch/requests/${fixture.reqId}/candidates`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.requestId, fixture.reqId);
    assert.equal(body.total, 2);
    assert.equal(body.candidates.length, 2);
  });

  it('returns 404 for unknown request ID', async () => {
    const authHeader = await loginAdmin();
    const unknownId = randomUUID();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/dispatch/requests/${unknownId}`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 404);
  });
});
