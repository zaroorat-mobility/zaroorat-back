import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545410';
const ADMIN_EMAIL = 'communications-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin communications management (integration)', () => {
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

  it('lists default notification templates', async () => {
    const { authorization } = await loginAdmin();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communications/templates',
      headers: { authorization },
    });

    assert.equal(response.statusCode, 200, response.payload);
    const body = response.json();
    assert.equal(Array.isArray(body.data), true);
    assert.ok(body.data.length >= 1);
    assert.equal(typeof body.meta.totalCount, 'number');
  });

  it('creates and updates a notification template', async () => {
    const { authorization } = await loginAdmin();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/communications/templates',
      headers: { authorization },
      payload: {
        eventKey: 'test_promo',
        channel: 'PUSH',
        subject: 'Promo',
        body: 'Hello {{name}}',
        variables: ['name'],
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const templateId = created.json().data.id;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/communications/templates/${templateId}`,
      headers: { authorization },
      payload: {
        subject: 'Updated Promo',
        isActive: false,
      },
    });
    assert.equal(updated.statusCode, 200, updated.payload);
    assert.equal(updated.json().data.subject, 'Updated Promo');
    assert.equal(updated.json().data.isActive, false);
  });

  it('sends a push broadcast to targeted users', async () => {
    const { authorization, adminUserId } = await loginAdmin();

    await db().client.userDevice.create({
      data: {
        userId: adminUserId,
        deviceId: 'test-device',
        fcmToken: 'test-fcm-token',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/communications/push/send',
      headers: { authorization },
      payload: {
        title: 'Test broadcast',
        body: 'Hello from admin',
        targeting: { userIds: [adminUserId] },
      },
    });

    assert.equal(response.statusCode, 201, response.payload);
    const broadcast = response.json().data;
    assert.equal(broadcast.status, 'SENT');
    assert.equal(broadcast.sentCount, 1);

    const history = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communications/history?channel=PUSH',
      headers: { authorization },
    });
    assert.equal(history.statusCode, 200, history.payload);
    assert.ok(history.json().data.length >= 1);
  });

  it('rejects unauthenticated template access', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/communications/templates',
    });
    assert.equal(response.statusCode, 401);
  });
});
