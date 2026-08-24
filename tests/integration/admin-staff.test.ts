import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876540001';
const OTHER_PHONE = '+919876540002';
const ADMIN_EMAIL = 'staff-test-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin staff users (integration)', () => {
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
    if (loggedIn.statusCode !== 200) {
      throw new Error(`admin login failed: ${loggedIn.payload}`);
    }
    const body = loggedIn.json();
    return {
      userId: body.user.id as string,
      accessToken: body.accessToken as string,
      refreshToken: body.refreshToken as string,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  it('lists provisioned staff accounts and creates another admin', async () => {
    const admin = await loginAdmin();
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: admin.authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const listBody = listed.json();
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].role, 'admin');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: admin.authHeader,
      payload: {
        firstName: 'Ops',
        lastName: 'Support',
        email: 'support@zaroorat.test',
        phoneNumber: '+919876540099',
        password: 'Support@12345',
        role: 'support',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const createdUser = created.json().data;
    assert.equal(createdUser.email, 'support@zaroorat.test');
    assert.equal(createdUser.role, 'support');
    assert.equal(createdUser.status, 'active');

    const listedAgain = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: admin.authHeader,
    });
    assert.equal(listedAgain.json().data.length, 2);
  });

  it('refuses staff management for a customer token', async () => {
    const customer = await loginAs(app, OTHER_PHONE);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: customer.authHeader,
    });
    assert.equal(listed.statusCode, 403);
  });
});
