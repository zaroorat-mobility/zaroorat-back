import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { seedAppConfig } from '../../prisma/seed/shared/app-config.js';

const ADMIN_PHONE = '+919876545060';
const ADMIN_EMAIL = 'app-config-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('app-config (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    await seedAppConfig(db().client);
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

  it('public GET /api/v1/app-config?app=driver&locale=en returns 200 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/app-config?app=driver&locale=en',
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.ok(body.data);
    assert.equal(body.data.app, 'driver');
    assert.equal(body.data.locale, 'en');
    assert.equal(typeof body.data.version, 'number');
    assert.ok(body.data.theme?.light);
    assert.ok(body.data.theme?.dark);
    assert.ok(Array.isArray(body.data.fonts));
    assert.ok(Array.isArray(body.data.locales));
    assert.equal(typeof body.data.strings, 'object');
  });

  it('returns ETag and 304 when If-None-Match matches', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/app-config?app=driver&locale=en',
    });
    assert.equal(first.statusCode, 200, first.payload);
    const etag = first.headers.etag;
    assert.ok(etag);
    assert.match(String(etag), /W\/"app-config-v\d+"/);

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/app-config?app=driver&locale=en',
      headers: { 'if-none-match': String(etag) },
    });
    assert.equal(second.statusCode, 304);
  });

  it('admin GET /api/v1/admin/app-config/themes requires auth', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/app-config/themes',
    });
    assert.equal(unauth.statusCode, 401);

    const adminHeaders = await loginAdmin();
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/app-config/themes?app=driver',
      headers: adminHeaders,
    });
    assert.equal(ok.statusCode, 200, ok.payload);
    assert.ok(Array.isArray(ok.json().data));
  });

  it('publish bumps version', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/app-config?app=driver&locale=en',
    });
    assert.equal(before.statusCode, 200, before.payload);
    const versionBefore = before.json().data.version as number;

    const adminHeaders = await loginAdmin();
    const publish = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/app-config/publish',
      headers: adminHeaders,
    });
    assert.equal(publish.statusCode, 200, publish.payload);
    assert.equal(publish.json().data.version, versionBefore + 1);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/app-config?app=driver&locale=en',
    });
    assert.equal(after.statusCode, 200, after.payload);
    assert.equal(after.json().data.version, versionBefore + 1);
  });
});
