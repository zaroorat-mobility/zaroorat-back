import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCity, ensureServiceZone, grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545001';
const ADMIN_EMAIL = 'fare-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

const SGR_CITYWIDE_POLYGON: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

const SGR_AIRPORT_POLYGON: number[][][] = [
  [
    [74.76, 34.0],
    [74.79, 34.0],
    [74.79, 34.03],
    [74.76, 34.03],
    [74.76, 34.0],
  ],
];

describe('admin fare rules (integration)', () => {
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

  function basePayload(overrides: Record<string, unknown> = {}) {
    const nextYear = new Date().getFullYear() + 1;
    return {
      vehicleType: 'cab',
      cityCode: 'GLOBAL',
      baseFare: 60,
      minimumFare: 80,
      perKmRate: 15,
      perMinuteRate: 1.5,
      freeWaitingMinutes: 5,
      waitingChargePerMinute: 3,
      status: 'active',
      effectiveFrom: `${nextYear}-01-01`,
      ...overrides,
    };
  }

  it('creates, lists, activates and deactivates fare rules', async () => {
    const authHeader = await loginAdmin();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload(),
    });
    assert.equal(created.statusCode, 201, created.payload);
    const rule = created.json().data;
    assert.equal(rule.vehicleType, 'cab');
    assert.equal(rule.status, 'active');
    // FR-047. `nightEnabled` and `nightChargePercentage` are gone from the DTO:
    // they reached `night_multiplier`, which only a branch gated on an
    // `isNightTrip` flag no caller ever set could charge.
    assert.equal(rule.nightEnabled, undefined);
    assert.equal(rule.nightChargePercentage, undefined);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((row: { id: string }) => row.id === rule.id));

    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fare-rules/${rule.id}/deactivate`,
      headers: authHeader,
    });
    assert.equal(deactivated.statusCode, 200, deactivated.payload);
    assert.equal(deactivated.json().data.status, 'inactive');

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fare-rules/${rule.id}/activate`,
      headers: authHeader,
    });
    assert.equal(activated.statusCode, 200, activated.payload);
    assert.equal(activated.json().data.status, 'active');
  });

  /// BD-5 B. `scheduled`, `rental` and `outstation` are no longer creatable:
  /// nothing in the ride paths passes a `serviceType`, so a rule created for any
  /// of them was listable, activatable and unreachable by every ride the platform
  /// prices. Rejecting the write is the point — the previous version of this test
  /// asserted that such a rule could be created, which was true and useless.
  it('refuses a service type no ride path can ever select (BD-5)', async () => {
    const authHeader = await loginAdmin();
    await ensureCity('SGR', 'Srinagar', 'Jammu & Kashmir');

    const scheduled = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({ cityCode: 'SGR', serviceType: 'scheduled' }),
    });
    assert.equal(scheduled.statusCode, 400, scheduled.payload);
  });

  it('creates SGR rules with zone and fee fields', async () => {
    const authHeader = await loginAdmin();
    await ensureCity('SGR', 'Srinagar', 'Jammu & Kashmir');
    const airportZoneId = await ensureServiceZone(
      'SGR',
      'SGR_AIRPORT',
      'SGR Airport',
      SGR_AIRPORT_POLYGON,
    );

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({
        cityCode: 'SGR',
        serviceType: 'instant',
        serviceZoneId: airportZoneId,
        bookingFee: 12,
        platformFeePct: 5,
        taxRatePct: 18,
        commissionRatePct: 20,
      }),
    });
    assert.equal(created.statusCode, 201, created.payload);
    const rule = created.json().data;
    assert.equal(rule.cityCode, 'SGR');
    assert.equal(rule.serviceType, 'instant');
    assert.equal(rule.serviceZoneId, airportZoneId);
    assert.equal(rule.serviceZoneName, 'SGR Airport');
    assert.equal(rule.bookingFee, 12);
    assert.equal(rule.platformFeePct, 5);
    assert.equal(rule.taxRatePct, 18);
    assert.equal(rule.commissionRatePct, 20);

    const zonesListed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/service-zones?cityCode=SGR',
      headers: authHeader,
    });
    assert.equal(zonesListed.statusCode, 200, zonesListed.payload);
    assert.ok(zonesListed.json().data.some((z: { id: string }) => z.id === airportZoneId));

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules?cityCode=SGR',
      headers: authHeader,
    });
    assert.equal(filtered.statusCode, 200, filtered.payload);
    assert.ok(filtered.json().data.some((row: { id: string }) => row.id === rule.id));
  });

  it('rejects a service zone that does not belong to the selected city', async () => {
    const authHeader = await loginAdmin();
    await ensureCity('SGR', 'Srinagar');
    await ensureCity('BLR', 'Bengaluru', 'Karnataka');
    const blrZoneId = await ensureServiceZone('BLR', 'BLR_CORE', 'BLR Core', [
      [
        [77.5, 12.9],
        [77.7, 12.9],
        [77.7, 13.1],
        [77.5, 13.1],
        [77.5, 12.9],
      ],
    ]);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({
        cityCode: 'SGR',
        serviceZoneId: blrZoneId,
      }),
    });
    assert.equal(rejected.statusCode, 409, rejected.payload);
  });

  it('deactivates the prior active rule for the same city, service type, and zone key', async () => {
    const authHeader = await loginAdmin();
    await ensureCity('SGR', 'Srinagar');
    await ensureServiceZone('SGR', 'SGR_CITYWIDE', 'Srinagar Citywide', SGR_CITYWIDE_POLYGON);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({
        cityCode: 'SGR',
        serviceType: 'instant',
        baseFare: 55,
      }),
    });
    assert.equal(first.statusCode, 201, first.payload);
    const firstId = first.json().data.id as string;

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({
        cityCode: 'SGR',
        serviceType: 'instant',
        baseFare: 65,
      }),
    });
    assert.equal(second.statusCode, 201, second.payload);

    const firstRow = await db().client.pricingRule.findUniqueOrThrow({ where: { id: firstId } });
    assert.equal(firstRow.isActive, false);
    assert.equal(second.json().data.status, 'active');

    const reactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fare-rules/${firstId}/activate`,
      headers: authHeader,
    });
    assert.equal(reactivated.statusCode, 200, reactivated.payload);

    const secondRow = await db().client.pricingRule.findUniqueOrThrow({
      where: { id: second.json().data.id },
    });
    assert.equal(secondRow.isActive, false);
    assert.equal(reactivated.json().data.status, 'active');
  });
});
