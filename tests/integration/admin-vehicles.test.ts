import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeAssignedVehicle, makeDriver } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876543011';
const DRIVER_PHONE = '+919876543012';
const ADMIN_EMAIL = 'vehicle-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin vehicles (integration)', () => {
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

  async function loginStaff() {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'system_admin');
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
    return { authorization: `Bearer ${loggedIn.json().accessToken}` };
  }

  it('lists vehicles and flags a vehicle for renewal with vehicles:write', async () => {
    const authHeader = await loginStaff();
    const driverUser = await loginAs(app, DRIVER_PHONE);
    await grantRole(driverUser.userId, 'driver');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const { vehicleId } = await makeAssignedVehicle(driverId);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/vehicles',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const match = listed.json().data.find((row: { id: string }) => row.id === vehicleId);
    assert.ok(match);

    const flagged = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/vehicles/${vehicleId}/flag-renewal`,
      headers: authHeader,
      payload: { notes: 'Insurance due' },
    });
    assert.equal(flagged.statusCode, 200, flagged.payload);
    assert.equal(flagged.json().data.verificationStatus, 'PENDING');

    const vehicle = await db().client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    assert.equal(vehicle.verificationStatus, 'PENDING');
  });
});
