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

  describe('zone and city write rules', () => {
    const box = (w: number, s: number, e: number, n: number): number[][][] => [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ];
    const ZONES = '/api/v1/admin/geographic/service-zones';
    const CITIES = '/api/v1/admin/geographic/cities';

    async function makeCity(code: string, boundary: number[][][]): Promise<string> {
      const id = await ensureCity(code, code);
      const geoJson = JSON.stringify({ type: 'Polygon', coordinates: boundary });
      await db().client.$executeRaw`
        UPDATE cities SET boundary = ST_GeomFromGeoJSON(${geoJson}) WHERE id = ${id}::uuid
      `;
      return id;
    }

    async function makeZone(
      headers: { authorization: string },
      code: string,
      coordinates: number[][][],
      extra: Record<string, unknown> = {},
    ) {
      return app.inject({
        method: 'POST',
        url: ZONES,
        headers,
        payload: { cityCode: 'SGR', code, name: code, coordinates, ...extra },
      });
    }

    it('refuses a restricted zone that blocks nothing, on create', async () => {
      const headers = await loginAdmin();
      await makeCity('SGR', SGR_BOUNDARY);
      const res = await makeZone(headers, 'SGR_RZ', box(74.8, 34.1, 74.82, 34.12), {
        zoneType: 'RESTRICTED',
        allowsPickup: true,
        allowsDropoff: true,
      });
      assert.equal(res.statusCode, 400, res.payload);
      assert.match(res.payload, /block/i);
    });

    it('refuses an update that leaves a restricted zone blocking nothing', async () => {
      const headers = await loginAdmin();
      await makeCity('SGR', SGR_BOUNDARY);
      const made = await makeZone(headers, 'SGR_RZ', box(74.8, 34.1, 74.82, 34.12), {
        zoneType: 'RESTRICTED',
        allowsPickup: false,
        allowsDropoff: true,
      });
      assert.equal(made.statusCode, 201, made.payload);
      const res = await app.inject({
        method: 'PATCH',
        url: `${ZONES}/${made.json().data.id}`,
        headers,
        payload: { allowsPickup: true },
      });
      assert.equal(res.statusCode, 400, res.payload);
    });

    it('refuses turning an open zone into a restricted zone that blocks nothing', async () => {
      const headers = await loginAdmin();
      await makeCity('SGR', SGR_BOUNDARY);
      const made = await makeZone(headers, 'SGR_SZ', box(74.8, 34.1, 74.82, 34.12));
      const res = await app.inject({
        method: 'PATCH',
        url: `${ZONES}/${made.json().data.id}`,
        headers,
        payload: { zoneType: 'RESTRICTED' },
      });
      assert.equal(res.statusCode, 400, res.payload);
    });

    it('still lets an older restricted zone that blocks nothing be deactivated', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);
      const geoJson = JSON.stringify({ type: 'Polygon', coordinates: box(74.8, 34.1, 74.82, 34.12) });
      const rows = await db().client.$queryRaw<Array<{ id: string }>>`
        INSERT INTO service_zones (id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${cityId}::uuid, 'OLD_RZ', 'Old', 'RESTRICTED'::"ServiceZoneType", ST_GeomFromGeoJSON(${geoJson}), true, true, true, NOW(), NOW())
        RETURNING id
      `;
      const res = await app.inject({
        method: 'POST',
        url: `${ZONES}/${rows[0]!.id}/deactivate`,
        headers,
      });
      assert.equal(res.statusCode, 200, res.payload);
    });

    it('stores a rider message and refuses one over 200 characters', async () => {
      const headers = await loginAdmin();
      await makeCity('SGR', SGR_BOUNDARY);
      const made = await makeZone(headers, 'SGR_RZ', box(74.8, 34.1, 74.82, 34.12), {
        zoneType: 'RESTRICTED',
        allowsPickup: false,
        riderMessage: 'No pickups near the cantonment.',
      });
      assert.equal(made.statusCode, 201, made.payload);
      assert.equal(made.json().data.riderMessage, 'No pickups near the cantonment.');

      const tooLong = await makeZone(headers, 'SGR_RZ2', box(74.8, 34.1, 74.82, 34.12), {
        zoneType: 'RESTRICTED',
        allowsPickup: false,
        riderMessage: 'x'.repeat(201),
      });
      assert.equal(tooLong.statusCode, 400, tooLong.payload);
    });

    it('refuses shrinking a city past a zone, and names the zone', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);
      await makeZone(headers, 'SGR_NORTH', box(74.8, 34.15, 74.82, 34.17));
      const res = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${cityId}`,
        headers,
        payload: { boundary: box(74.7, 34.0, 75.0, 34.1) },
      });
      assert.equal(res.statusCode, 409, res.payload);
      assert.match(res.payload, /SGR_NORTH/);
    });

    it('allows shrinking a city past a zone that is inactive', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);
      const zone = await makeZone(headers, 'SGR_NORTH', box(74.8, 34.15, 74.82, 34.17));
      await app.inject({
        method: 'POST',
        url: `${ZONES}/${zone.json().data.id}/deactivate`,
        headers,
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${cityId}`,
        headers,
        payload: { boundary: box(74.7, 34.0, 75.0, 34.1) },
      });
      assert.equal(res.statusCode, 200, res.payload);
    });

    it('refuses a boundary overlapping another active city, on update and create', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);
      await makeCity('BDG', box(74.5, 33.8, 74.75, 34.05));

      const updated = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${cityId}`,
        headers,
        payload: { boundary: box(74.6, 33.9, 75.0, 34.2) },
      });
      assert.equal(updated.statusCode, 409, updated.payload);
      assert.match(updated.payload, /BDG/);

      const created = await app.inject({
        method: 'POST',
        url: CITIES,
        headers,
        payload: { code: 'NEW', name: 'New', boundary: box(74.6, 33.9, 74.72, 34.02) },
      });
      assert.equal(created.statusCode, 409, created.payload);
      assert.match(created.payload, /BDG/);
    });

    it('allows two cities that only share an edge', async () => {
      const headers = await loginAdmin();
      await makeCity('SGR', SGR_BOUNDARY);
      const res = await app.inject({
        method: 'POST',
        url: CITIES,
        headers,
        payload: { code: 'NXT', name: 'Next door', boundary: box(75.0, 34.0, 75.2, 34.2) },
      });
      assert.equal(res.statusCode, 201, res.payload);
    });

    it('does not count an inactive city as an overlap', async () => {
      const headers = await loginAdmin();
      const oldId = await makeCity('OLD', box(74.6, 33.9, 74.72, 34.02));
      await db().client.city.update({ where: { id: oldId }, data: { isActive: false } });
      const res = await app.inject({
        method: 'POST',
        url: CITIES,
        headers,
        payload: { code: 'NEW', name: 'New', boundary: box(74.6, 33.9, 74.72, 34.02) },
      });
      assert.equal(res.statusCode, 201, res.payload);
    });

    it('checks for overlap when an inactive city is turned on', async () => {
      const headers = await loginAdmin();
      await makeCity('SGR', SGR_BOUNDARY);
      const oldId = await makeCity('OLD', box(74.8, 34.1, 74.9, 34.15));
      await db().client.city.update({ where: { id: oldId }, data: { isActive: false } });
      const res = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${oldId}`,
        headers,
        payload: { isActive: true },
      });
      assert.equal(res.statusCode, 409, res.payload);
      assert.match(res.payload, /SGR/);
    });

    it('keeps the old shape in the audit log after a boundary edit, for city and zone', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);
      const city = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${cityId}`,
        headers,
        payload: { boundary: box(74.65, 34.0, 75.0, 34.2) },
      });
      assert.equal(city.statusCode, 200, city.payload);
      const cityLog = await db().client.adminActivityLog.findFirst({
        where: { entityType: 'city', entityId: cityId },
        orderBy: { createdAt: 'desc' },
      });
      const cityBefore = (cityLog?.metadata as { before?: { boundary?: number[][][] } }).before;
      assert.deepEqual(cityBefore?.boundary, SGR_BOUNDARY);

      const oldZone = box(74.8, 34.1, 74.82, 34.12);
      const made = await makeZone(headers, 'SGR_SZ', oldZone);
      const zoneId = made.json().data.id as string;
      const zone = await app.inject({
        method: 'PATCH',
        url: `${ZONES}/${zoneId}`,
        headers,
        payload: { coordinates: box(74.8, 34.1, 74.83, 34.12) },
      });
      assert.equal(zone.statusCode, 200, zone.payload);
      const zoneLog = await db().client.adminActivityLog.findFirst({
        where: { entityType: 'service_zone', entityId: zoneId, action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      const zoneBefore = (zoneLog?.metadata as { before?: { boundary?: number[][][] } }).before;
      assert.deepEqual(zoneBefore?.boundary, oldZone);
    });

    it('leaves surge areas out of the zone list', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);
      const geoJson = JSON.stringify({ type: 'Polygon', coordinates: box(74.8, 34.1, 74.82, 34.12) });
      await db().client.$executeRaw`
        INSERT INTO service_zones (id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${cityId}::uuid, 'SGR_SURGE', 'Surge', 'SURGE'::"ServiceZoneType", ST_GeomFromGeoJSON(${geoJson}), true, true, true, NOW(), NOW())
      `;
      await makeZone(headers, 'SGR_SZ', box(74.8, 34.1, 74.82, 34.12));

      const listed = await app.inject({ method: 'GET', url: `${ZONES}?cityCode=SGR`, headers });
      const codes = (listed.json().data as Array<{ code: string }>).map((z) => z.code);
      assert.deepEqual(codes, ['SGR_SZ']);
    });

    it('stores and returns where rides can start, and the surge cap', async () => {
      const headers = await loginAdmin();
      const cityId = await makeCity('SGR', SGR_BOUNDARY);

      const before = await app.inject({ method: 'GET', url: `${CITIES}/${cityId}`, headers });
      assert.equal(before.json().data.coverageMode, 'WHOLE_CITY');
      assert.equal(before.json().data.maxSurgeMultiplier, 2);

      const res = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${cityId}`,
        headers,
        payload: { coverageMode: 'ZONES_ONLY' },
      });
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(res.json().data.coverageMode, 'ZONES_ONLY');

      const list = await app.inject({ method: 'GET', url: CITIES, headers });
      const row = (list.json().data as Array<{ code: string; coverageMode: string }>).find(
        (c) => c.code === 'SGR',
      );
      assert.equal(row?.coverageMode, 'ZONES_ONLY');
    });
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
