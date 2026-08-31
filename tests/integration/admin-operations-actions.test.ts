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
  makeVehicleType,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

let phoneCounter = 8400;
function nextPhone() {
  return `+91987654${phoneCounter++}`;
}

describe('admin operations actions & notes (integration)', () => {
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
    const phone = nextPhone();
    const email = `admin-${Date.now()}@zaroorat.test`;
    const password = 'Admin@12345';
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'admin');
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
      authorization: `Bearer ${loggedIn.json().accessToken}`,
      adminUserId: seed.userId,
    };
  }

  async function seedTestRideFixture() {
    const customerPhone = nextPhone();
    const driverPhone = nextPhone();

    const customer = await loginAs(app, customerPhone);
    await db().client.userProfile.upsert({
      where: { userId: customer.userId },
      update: { firstName: 'Sam', lastName: 'Customer' },
      create: { userId: customer.userId, firstName: 'Sam', lastName: 'Customer' },
    });

    const driverUser = await loginAs(app, driverPhone);
    await db().client.userProfile.upsert({
      where: { userId: driverUser.userId },
      update: { firstName: 'Dave', lastName: 'Driver' },
      create: { userId: driverUser.userId, firstName: 'Dave', lastName: 'Driver' },
    });

    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const vehicleTypeId = await makeVehicleType({ code: `AUTO_${Date.now()}`, name: 'Auto' });
    const vehicleId = await makeVehicle(vehicleTypeId);
    const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
    const rideId = await makeRide({
      requestId,
      customerId: customer.userId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status: 'ACCEPTED',
    });

    return { customer, driverUser, driverId, vehicleId, requestId, rideId };
  }

  it('rejects unauthenticated requests to ride actions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operations/rides/dummy-id/notes',
      payload: { note: 'test' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects users without operations:write permission for cancel and notes', async () => {
    const regularUser = await loginAs(app, nextPhone());
    const resNote = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operations/rides/dummy-id/notes',
      headers: regularUser.authHeader,
      payload: { note: 'test' },
    });
    assert.equal(resNote.statusCode, 403);

    const resCancel = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operations/rides/dummy-id/actions/cancel',
      headers: regularUser.authHeader,
      payload: { reasonCode: 'ADMIN_TEST' },
    });
    assert.equal(resCancel.statusCode, 403);
  });

  it('adds and lists internal ops notes on a ride', async () => {
    const auth = await loginAdmin();
    const fixture = await seedTestRideFixture();

    // Add note 1
    const resAdd1 = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/notes`,
      headers: { authorization: auth.authorization },
      payload: { note: 'Customer contacted support regarding driver delay.' },
    });
    assert.equal(resAdd1.statusCode, 201, resAdd1.payload);
    const note1 = resAdd1.json().data;
    assert.equal(note1.note, 'Customer contacted support regarding driver delay.');
    assert.equal(note1.rideId, fixture.rideId);

    // Add note 2
    const resAdd2 = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/notes`,
      headers: { authorization: auth.authorization },
      payload: { note: 'Driver informed they are 2 mins away in traffic.' },
    });
    assert.equal(resAdd2.statusCode, 201, resAdd2.payload);

    // List notes
    const resList = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/notes`,
      headers: { authorization: auth.authorization },
    });
    assert.equal(resList.statusCode, 200, resList.payload);
    const list = resList.json().data;
    assert.equal(list.length, 2);
    assert.equal(list[0].note, 'Driver informed they are 2 mins away in traffic.');
    assert.equal(list[1].note, 'Customer contacted support regarding driver delay.');
  });

  it('performs admin cancel action on active ride and logs activity', async () => {
    const auth = await loginAdmin();
    const fixture = await seedTestRideFixture();

    const resCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/actions/cancel`,
      headers: { authorization: auth.authorization },
      payload: {
        reasonCode: 'VEHICLE_BREAKDOWN',
        reasonText: 'Vehicle broken down on highway. Cancelled by ops command.',
      },
    });

    assert.equal(resCancel.statusCode, 200, resCancel.payload);
    const updatedRide = resCancel.json().data;
    assert.equal(updatedRide.status, 'CANCELLED_BY_SYSTEM');
    assert.ok(updatedRide.cancelledAt);

    // Check ride audit logs
    const resAudit = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/rides/${fixture.rideId}/audit`,
      headers: { authorization: auth.authorization },
    });
    assert.equal(resAudit.statusCode, 200, resAudit.payload);
    const auditBody = resAudit.json();
    assert.ok(Array.isArray(auditBody.data));
    assert.ok(auditBody.data.length >= 1);
    const cancelLog = auditBody.data.find((l) => l.action === 'UPDATE');
    assert.ok(cancelLog);
    assert.match(cancelLog.summary, /Operations admin cancelled ride/);
  });
});
