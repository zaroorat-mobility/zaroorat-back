import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, ensureCity } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { VEHICLE_TYPE_SEED } from '../../prisma/seed/shared/vehicle-types.js';

const CAR = VEHICLE_TYPE_SEED.find((type) => type.category === 'car');
if (!CAR) throw new Error('the vehicle seed needs a car variant');

const ADMIN_PHONE = '+919876545021';
const ADMIN_EMAIL = 'surge-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin surge windows (integration)', () => {
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

  it('creates a surge zone/window and lists enriched windows', async () => {
    const authHeader = await loginAdmin();
    const cab = await db().client.vehicleType.findUnique({ where: { code: CAR.code } });
    assert.ok(cab);

    const zone = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-zones',
      headers: authHeader,
      payload: {
        cityCode: 'SGR',
        name: 'Test Citywide',
        coordinates: [
          [
            [74.7, 34.0],
            [75.0, 34.0],
            [75.0, 34.2],
            [74.7, 34.2],
            [74.7, 34.0],
          ],
        ],
      },
    });
    assert.equal(zone.statusCode, 201, zone.payload);
    const zoneId = zone.json().id as string;

    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-windows',
      headers: authHeader,
      payload: {
        zoneId,
        vehicleTypeId: cab!.id,
        multiplier: 1.5,
        startsAt,
        endsAt,
        reason: 'Morning Peak Cab Surge',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/surge-windows',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    const windows = listed.json() as Array<{
      id: string;
      zoneName?: string;
      vehicleTypeCode?: string | null;
      vehicleTypeName?: string | null;
      reason?: string | null;
    }>;
    const row = windows.find((w) => w.id === created.json().id);
    assert.ok(row);
    assert.equal(row!.zoneName, 'Test Citywide');
    assert.equal(row!.vehicleTypeCode, CAR.code);
    assert.equal(row!.vehicleTypeName, CAR.hasAc ? `${CAR.name} (AC)` : CAR.name);
    assert.equal(row!.reason, 'Morning Peak Cab Surge');
  });

  describe('surge cap and schedule', () => {
    const zonePayload = {
      cityCode: 'SGR',
      name: 'Schedule Zone',
      coordinates: [
        [
          [74.7, 34.0],
          [75.0, 34.0],
          [75.0, 34.2],
          [74.7, 34.2],
          [74.7, 34.0],
        ],
      ],
    };

    it('sets a city cap, records who did it, and refuses one above the platform limit', async () => {
      const authHeader = await loginAdmin();
      const cityId = await ensureCity('PNQ', 'Pune');

      const saved = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/surge-settings/PNQ',
        headers: authHeader,
        payload: { maxSurgeMultiplier: 1.5 },
      });
      assert.equal(saved.statusCode, 200, saved.payload);
      assert.equal(saved.json().maxSurgeMultiplier, 1.5);

      const city = await db().client.city.findUniqueOrThrow({ where: { id: cityId } });
      assert.equal(Number(city.maxSurgeMultiplier), 1.5);

      const log = await db().client.adminActivityLog.findFirst({
        where: { entityType: 'city', entityId: cityId },
        orderBy: { createdAt: 'desc' },
      });
      assert.ok(log, 'the change is audited');
      assert.equal(
        (log.metadata as { before?: { maxSurgeMultiplier?: number } }).before?.maxSurgeMultiplier,
        2,
      );

      const tooHigh = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/surge-settings/PNQ',
        headers: authHeader,
        payload: { maxSurgeMultiplier: 2.5 },
      });
      assert.equal(tooHigh.statusCode, 400, tooHigh.payload);

      const unknown = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/surge-settings/NOPE',
        headers: authHeader,
        payload: { maxSurgeMultiplier: 1.5 },
      });
      assert.equal(unknown.statusCode, 404, unknown.payload);
    });

    it('stores days of the week, and refuses a day that does not exist', async () => {
      const authHeader = await loginAdmin();
      const zone = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-zones',
        headers: authHeader,
        payload: zonePayload,
      });
      const base = {
        zoneId: zone.json().id as string,
        multiplier: 1.5,
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      };

      const saved = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-windows',
        headers: authHeader,
        payload: { ...base, daysOfWeek: [6, 0] },
      });
      assert.equal(saved.statusCode, 201, saved.payload);
      assert.deepEqual(saved.json().daysOfWeek, [6, 0]);

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/surge-windows/${saved.json().id}`,
        headers: authHeader,
        payload: { daysOfWeek: [1] },
      });
      assert.equal(updated.statusCode, 200, updated.payload);
      assert.deepEqual(updated.json().daysOfWeek, [1]);

      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-windows',
        headers: authHeader,
        payload: { ...base, daysOfWeek: [7] },
      });
      assert.equal(bad.statusCode, 400, bad.payload);
    });

    it('fills both vehicle columns, names the vehicle, and marks new rules as manual', async () => {
      const authHeader = await loginAdmin();
      const cab = await db().client.vehicleType.findUniqueOrThrow({
        where: { code: 'CAB_ECONOMY_NON_AC' },
      });
      const zone = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-zones',
        headers: authHeader,
        payload: zonePayload,
      });
      const saved = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-windows',
        headers: authHeader,
        payload: {
          zoneId: zone.json().id as string,
          vehicleTypeId: cab.id,
          multiplier: 1.5,
          startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      assert.equal(saved.statusCode, 201, saved.payload);
      assert.equal(saved.json().vehicleTypeName, cab.name);
      assert.equal(saved.json().source, 'MANUAL');

      const row = await db().client.surgeWindow.findUniqueOrThrow({
        where: { id: saved.json().id as string },
      });
      assert.equal(row.vehicleTypeId, cab.id);
      assert.deepEqual(row.vehicleTypeIds, [cab.id]);
    });

    it('tells the AC variant apart, since it shares its name with the Non-AC one', async () => {
      const authHeader = await loginAdmin();
      const ac = await db().client.vehicleType.findUniqueOrThrow({
        where: { code: 'CAB_ECONOMY_AC' },
      });
      const zone = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-zones',
        headers: authHeader,
        payload: zonePayload,
      });
      const saved = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-windows',
        headers: authHeader,
        payload: {
          zoneId: zone.json().id as string,
          vehicleTypeId: ac.id,
          multiplier: 1.5,
          startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      assert.equal(saved.statusCode, 201, saved.payload);
      assert.equal(saved.json().vehicleTypeName, `${ac.name} (AC)`);
    });
  });

  /// FR-013 / FR-014. Peak-hour rules are stored AND evaluated now; the demand
  /// and supply thresholds are gone. The previous version of this test asserted
  /// the thresholds round-tripped, which was true and meant nothing — no signal
  /// existed anywhere for them to be compared against, so they were writable and
  /// inert.
  it('stores peak-hour rules and no longer accepts inert thresholds', async () => {
    const authHeader = await loginAdmin();
    const cab = await db().client.vehicleType.findUnique({ where: { code: CAR.code } });
    assert.ok(cab);

    const zone = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-zones',
      headers: authHeader,
      payload: {
        cityCode: 'SGR',
        name: 'Threshold Zone',
        coordinates: [
          [
            [74.7, 34.0],
            [75.0, 34.0],
            [75.0, 34.2],
            [74.7, 34.2],
            [74.7, 34.0],
          ],
        ],
      },
    });
    assert.equal(zone.statusCode, 201, zone.payload);
    const zoneId = zone.json().id as string;

    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-windows',
      headers: authHeader,
      payload: {
        zoneId,
        vehicleTypeId: cab!.id,
        multiplier: 1.8,
        startsAt,
        reason: 'Peak Demand Surge',
        peakHourStart: '08:00',
        peakHourEnd: '10:00',
        isPeakHourOnly: true,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const body = created.json() as Record<string, unknown>;
    assert.equal(body.peakHourStart, '08:00');
    assert.equal(body.peakHourEnd, '10:00');
    assert.equal(body.isPeakHourOnly, true);
    assert.equal(
      body.demandThresholdPct,
      undefined,
      'a field nothing evaluates must not be returned',
    );
    assert.equal(body.supplyThresholdPct, undefined);
  });
  it('refuses an unknown or retired vehicle type instead of a 500 or a dead rule', async () => {
    const authHeader = await loginAdmin();
    const zone = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-zones',
      headers: authHeader,
      payload: {
        cityCode: 'SGR',
        name: 'Vehicle Check Zone',
        coordinates: [
          [
            [74.7, 34.0],
            [75.0, 34.0],
            [75.0, 34.2],
            [74.7, 34.2],
            [74.7, 34.0],
          ],
        ],
      },
    });
    assert.equal(zone.statusCode, 201, zone.payload);
    const window = (vehicleTypeId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/surge-windows',
        headers: authHeader,
        payload: {
          zoneId: zone.json().id as string,
          vehicleTypeId,
          multiplier: 1.4,
          startsAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });

    const unknown = await window('00000000-0000-7000-8000-000000000000');
    assert.equal(unknown.statusCode, 404, unknown.payload);
    assert.equal(unknown.json().error.code, 'VEHICLE_TYPE_NOT_FOUND');

    const car = await db().client.vehicleType.findUniqueOrThrow({ where: { code: CAR.code } });
    await db().client.vehicleType.update({ where: { id: car.id }, data: { isActive: false } });
    const retired = await window(car.id);
    assert.equal(retired.statusCode, 409, retired.payload);
    assert.equal(retired.json().error.code, 'VEHICLE_TYPE_INACTIVE');
    assert.equal(await db().client.surgeWindow.count({ where: { vehicleTypeId: car.id } }), 0);
  });
});
