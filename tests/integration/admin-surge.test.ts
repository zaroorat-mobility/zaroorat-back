import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

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
    const cab = await db().client.vehicleType.findUnique({ where: { code: 'CAB_ECONOMY' } });
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
      reason?: string | null;
    }>;
    const row = windows.find((w) => w.id === created.json().id);
    assert.ok(row);
    assert.equal(row!.zoneName, 'Test Citywide');
    assert.equal(row!.vehicleTypeCode, 'CAB_ECONOMY');
    assert.equal(row!.reason, 'Morning Peak Cab Surge');
  });

  /// FR-013 / FR-014. Peak-hour rules are stored AND evaluated now; the demand
  /// and supply thresholds are gone. The previous version of this test asserted
  /// the thresholds round-tripped, which was true and meant nothing — no signal
  /// existed anywhere for them to be compared against, so they were writable and
  /// inert.
  it('stores peak-hour rules and no longer accepts inert thresholds', async () => {
    const authHeader = await loginAdmin();
    const cab = await db().client.vehicleType.findUnique({ where: { code: 'CAB_ECONOMY' } });
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
});
