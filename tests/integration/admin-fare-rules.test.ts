import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545001';
const ADMIN_EMAIL = 'fare-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin fare rules (integration)', () => {
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

  it('creates, lists, activates and deactivates fare rules', async () => {
    const authHeader = await loginAdmin();
    // CAB_ECONOMY is seeded by resetState via seedVehicleTypes
    const nextYear = new Date().getFullYear() + 1;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: {
        vehicleType: 'cab',
        cityCode: 'GLOBAL',
        baseFare: 60,
        minimumFare: 80,
        perKmRate: 15,
        perMinuteRate: 1.5,
        freeWaitingMinutes: 5,
        waitingChargePerMinute: 3,
        nightEnabled: true,
        nightChargePercentage: 25,
        status: 'active',
        effectiveFrom: `${nextYear}-01-01`,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const rule = created.json().data;
    assert.equal(rule.vehicleType, 'cab');
    assert.equal(rule.status, 'active');
    assert.equal(rule.nightEnabled, true);
    assert.equal(rule.nightChargePercentage, 25);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((row: { id: string }) => row.id === rule.id));

    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fare-rules/${rule.id}/deactivate`,
      headers: authHeader,
    });
    assert.equal(deactivated.statusCode, 200, deactivated.payload);
    assert.equal(deactivated.json().data.status, 'inactive');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fare-rules/${rule.id}/activate`,
      headers: authHeader,
    });
    assert.equal(activated.statusCode, 200, activated.payload);
    assert.equal(activated.json().data.status, 'active');
  });
});
