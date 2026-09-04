import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545080';
const ADMIN_EMAIL = 'docs-ops-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const DRIVER_PHONE = '+919876545081';

describe('admin document compliance (integration)', () => {
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

  async function loginFinance() {
    const seed = await loginAs(app, '+919876545082');
    await grantRole(seed.userId, 'finance');
    const again = await loginAs(app, '+919876545082');
    return { authorization: `Bearer ${again.accessToken}` };
  }

  async function seedDriverWithDocs() {
    const driverUser = await loginAs(app, DRIVER_PHONE);
    await grantRole(driverUser.userId, 'driver');
    const driverId = await makeDriver(driverUser.userId, { verified: true });

    const pending = await db().client.driverDocument.create({
      data: {
        driverId,
        documentType: 'AADHAAR',
        verificationStatus: 'PENDING',
        fileUrl: 'https://example.invalid/aadhaar.jpg',
        expiresAt: new Date(Date.now() + 10 * 86400000),
      },
    });

    await db().client.driverDocument.create({
      data: {
        driverId,
        documentType: 'PUC',
        verificationStatus: 'VERIFIED',
        fileUrl: 'https://example.invalid/puc.jpg',
        expiresAt: new Date(Date.now() - 2 * 86400000),
      },
    });

    return { driverId, pendingDocumentId: pending.id };
  }

  it('rejects unauthenticated and finance-only access to document routes', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/documents/compliance',
    });
    assert.equal(unauth.statusCode, 401);

    const finance = await loginFinance();
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/documents/compliance',
      headers: finance,
    });
    assert.equal(forbidden.statusCode, 403);
  });

  it('lists and returns driver document compliance', async () => {
    const { driverId } = await seedDriverWithDocs();
    const admin = await loginAdmin();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/documents/compliance',
      headers: admin,
    });
    assert.equal(list.statusCode, 200, list.payload);
    assert.ok(list.json().data.some((row: { driverId: string }) => row.driverId === driverId));
    assert.ok(list.json().meta.totalCount >= 1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/documents/compliance/${driverId}`,
      headers: admin,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.driverId, driverId);
    assert.ok(Array.isArray(detail.json().data.documents));
    assert.ok(detail.json().data.documents.length >= 2);
    assert.ok(detail.json().data.documents.some((d: { status: string }) => d.status === 'expired'));
  });

  it('gets and updates document compliance settings', async () => {
    const admin = await loginAdmin();

    const initial = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/documents/settings',
      headers: admin,
    });
    assert.equal(initial.statusCode, 200, initial.payload);
    assert.equal(typeof initial.json().data.alertThresholdDays, 'number');

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/documents/settings',
      headers: admin,
      payload: {
        alertThresholdDays: 45,
        notifyEmail: false,
        notifyPush: true,
      },
    });
    assert.equal(updated.statusCode, 200, updated.payload);
    assert.equal(updated.json().data.alertThresholdDays, 45);
    assert.equal(updated.json().data.notifyEmail, false);
    assert.equal(updated.json().data.notifyPush, true);

    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/documents/settings',
      headers: admin,
    });
    assert.equal(again.statusCode, 200, again.payload);
    assert.equal(again.json().data.alertThresholdDays, 45);
  });

  it('reviews a pending driver document', async () => {
    const { pendingDocumentId } = await seedDriverWithDocs();
    const admin = await loginAdmin();

    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/documents/${pendingDocumentId}/review`,
      headers: admin,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    assert.equal(verified.json().data.id, pendingDocumentId);
    assert.equal(verified.json().data.verificationStatus, 'verified');

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/documents/${pendingDocumentId}/review`,
      headers: admin,
      payload: { status: 'REJECTED', rejectionReason: 'Image is not readable' },
    });
    assert.equal(rejected.statusCode, 200, rejected.payload);
    assert.equal(rejected.json().data.verificationStatus, 'rejected');
    assert.equal(rejected.json().data.rejectionReason, 'Image is not readable');
  });
});
