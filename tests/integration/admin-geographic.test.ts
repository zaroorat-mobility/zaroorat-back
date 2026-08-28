import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCity, ensureCountry, grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545031';
const ADMIN_EMAIL = 'geo-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

const SGR_BOUNDARY: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

describe('admin geographic management (integration)', () => {
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

  it('lists countries and creates a service zone with typed zoneType', async () => {
    const authHeader = await loginAdmin();
    await ensureCity('SGR', 'Srinagar');
    const boundaryJson = JSON.stringify({ type: 'Polygon', coordinates: SGR_BOUNDARY });
    await db().client.$executeRaw`
      UPDATE cities SET boundary = ST_GeomFromGeoJSON(${boundaryJson})
      WHERE code = 'SGR'
    `;

    const countries = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/geographic/countries',
      headers: authHeader,
    });
    assert.equal(countries.statusCode, 200, countries.payload);

    const zoneCode = `TEST_ZONE_${Date.now()}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/geographic/service-zones',
      headers: authHeader,
      payload: {
        cityCode: 'SGR',
        code: zoneCode,
        name: 'Test Zone',
        zoneType: 'SERVICE',
        coordinates: SGR_BOUNDARY,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    assert.equal(created.json().data.zoneType, 'SERVICE');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/geographic/service-zones?cityCode=SGR',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((z: { code: string }) => z.code === zoneCode));
  });

  it('creates a new state', async () => {
    const authHeader = await loginAdmin();
    await ensureCountry();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/geographic/states',
      headers: authHeader,
      payload: {
        countryCode: 'IN',
        code: 'MH',
        name: 'Maharashtra',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    assert.equal(created.json().data.code, 'MH');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/geographic/states?countryCode=IN',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((s: { code: string }) => s.code === 'MH'));
  });

  it('rejects invalid polygon geometry', async () => {
    const authHeader = await loginAdmin();
    await ensureCity('SGR', 'Srinagar');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/geographic/service-zones',
      headers: authHeader,
      payload: {
        cityCode: 'SGR',
        code: 'BAD',
        name: 'Bad Zone',
        zoneType: 'SERVICE',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.payload);
  });
});
