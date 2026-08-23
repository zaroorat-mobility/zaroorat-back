import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState, FIXED_OTP } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const BASE = '/api/v1/auth';
const ADMIN_PHONE = '+919876510001';
const CUSTOMER_PHONE = '+919876510002';
const ADMIN_EMAIL = 'ops@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin login (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function seedAdmin(): Promise<string> {
    const user = await db().client.user.create({
      data: {
        phoneNumber: ADMIN_PHONE,
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        status: 'ACTIVE',
        isPhoneVerified: true,
        isEmailVerified: true,
        profile: { create: { firstName: 'Ops', lastName: 'Admin' } },
      },
    });
    await grantRole(user.id, 'admin');
    return user.id;
  }

  async function seedCustomer(): Promise<string> {
    const user = await db().client.user.create({
      data: {
        phoneNumber: CUSTOMER_PHONE,
        email: 'rider@zaroorat.test',
        passwordHash: hashPassword(ADMIN_PASSWORD),
        status: 'ACTIVE',
        isPhoneVerified: true,
        profile: { create: { firstName: 'Demo', lastName: 'Rider' } },
      },
    });
    await grantRole(user.id, 'customer');
    return user.id;
  }

  it('logs a staff account in with email and password', async () => {
    await seedAdmin();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/login`,
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.ok(body.accessToken && body.refreshToken);
    assert.deepEqual(body.user.roles, ['admin']);
    assert.equal(body.user.isNew, false);
    assert.equal(body.user.email, ADMIN_EMAIL);
    assert.equal(body.user.name, 'Ops Admin');
  });

  it('refuses a rider/customer email+password even when the password is correct', async () => {
    await seedCustomer();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/login`,
      payload: { email: 'rider@zaroorat.test', password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 401, res.payload);
    assert.equal(res.json().error.code, 'INVALID_CREDENTIALS');
    assert.equal((await db().client.userSession.findMany()).length, 0);
  });

  it('refuses a wrong password with the same error as an unknown email', async () => {
    await seedAdmin();
    const wrong = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/login`,
      payload: { email: ADMIN_EMAIL, password: 'DefinitelyWrong1!' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/login`,
      payload: { email: 'nobody@zaroorat.test', password: ADMIN_PASSWORD },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.equal(wrong.json().error.code, unknown.json().error.code);
  });

  it('logs a staff account in with a phone OTP and never creates a new account', async () => {
    await seedAdmin();
    const sent = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/otp/send`,
      payload: { phoneNumber: ADMIN_PHONE },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    const verified = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/otp/verify`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        phoneNumber: ADMIN_PHONE,
        code: FIXED_OTP,
        challengeId: sent.json().challengeId,
      },
    });
    assert.equal(verified.statusCode, 200, verified.payload);
    assert.deepEqual(verified.json().user.roles, ['admin']);
    assert.equal((await db().client.user.findMany()).length, 1);
  });

  it('does not let a customer OTP unlock the admin panel', async () => {
    await seedCustomer();
    const customerSend = await app.inject({
      method: 'POST',
      url: `${BASE}/otp/send`,
      payload: { phoneNumber: CUSTOMER_PHONE },
    });
    assert.equal(customerSend.statusCode, 200, customerSend.payload);
    const adminVerify = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/otp/verify`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        phoneNumber: CUSTOMER_PHONE,
        code: FIXED_OTP,
        challengeId: customerSend.json().challengeId,
      },
    });
    assert.equal(adminVerify.statusCode, 401, adminVerify.payload);
    assert.equal(adminVerify.json().error.code, 'INVALID_CREDENTIALS');
    assert.equal((await db().client.userSession.findMany()).length, 0);
  });

  it('acks admin OTP send for a customer number without creating an account', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: `${BASE}/admin/otp/send`,
      payload: { phoneNumber: '+919876510099' },
    });
    assert.equal(sent.statusCode, 200, sent.payload);
    assert.ok(sent.json().challengeId);
    assert.equal((await db().client.user.findMany()).length, 0);
  });
});
