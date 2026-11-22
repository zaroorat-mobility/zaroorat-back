import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { VEHICLE_TYPE_SEED } from '../../prisma/seed/shared/vehicle-types.js';

const ADMIN_PHONE = '+919876545011';
const ADMIN_EMAIL = 'cancel-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin cancellation policies (integration)', () => {
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

  it('creates and lists cancellation policies', async () => {
    const authHeader = await loginAdmin();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers: authHeader,
      payload: {
        actor: 'rider',
        scenario: 'after_assignment',
        chargeType: 'fixed',
        chargeAmount: 20,
        status: 'active',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const policy = created.json().data;
    assert.equal(policy.actor, 'rider');
    assert.equal(policy.scenario, 'after_assignment');
    assert.equal(policy.chargeType, 'fixed');
    assert.equal(policy.chargeAmount, 20);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/cancellation-policies',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((row: { id: string }) => row.id === policy.id));

    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/cancellation-policies/${policy.id}/deactivate`,
      headers: authHeader,
    });
    assert.equal(deactivated.statusCode, 200, deactivated.payload);
    assert.equal(deactivated.json().data.status, 'inactive');
  });
  it('scopes a policy to an exact vehicle type and refuses the generic "cab"', async () => {
    const authHeader = await loginAdmin();
    const car = VEHICLE_TYPE_SEED.find((type) => type.category === 'car');
    assert.ok(car);
    const row = await db().client.vehicleType.findUniqueOrThrow({ where: { code: car.code } });
    const base = {
      actor: 'rider',
      scenario: 'after_arrival',
      chargeType: 'fixed',
      chargeAmount: 30,
    };

    const generic = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers: authHeader,
      payload: { ...base, vehicleType: 'cab' },
    });
    assert.equal(generic.statusCode, 404, generic.payload);

    const exact = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers: authHeader,
      payload: { ...base, vehicleTypeId: row.id },
    });
    assert.equal(exact.statusCode, 201, exact.payload);
    assert.equal(exact.json().data.vehicleTypeId, row.id);
  });
});
