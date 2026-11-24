import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCity, ensureServiceZone, grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { VEHICLE_TYPE_SEED } from '../../prisma/seed/shared/vehicle-types.js';

// Two cab variants from the canonical catalog — the case the old
// `cab -> CAB_ECONOMY` alias collapsed into one.
const CAR_TYPES = VEHICLE_TYPE_SEED.filter((type) => type.category === 'car');
if (CAR_TYPES.length < 2) throw new Error('the vehicle seed needs two car variants');
const CAR_A = CAR_TYPES[0]!;
const CAR_B = CAR_TYPES[1]!;

async function vehicleTypeId(code: string): Promise<string> {
  const row = await db().client.vehicleType.findUniqueOrThrow({ where: { code } });
  return row.id;
}

const ADMIN_PHONE = '+919876545001';
const ADMIN_EMAIL = 'fare-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const RETIRED_IN_TESTS = ['CAB_MINI_AC', 'CAB_XL_AC'];

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
    // resetState seeds an open-ended GLOBAL rate card per type, and a second
    // active overlapping rule is refused (FARE_RULE_CONFLICT). These tests create
    // their own GLOBAL rules, so start them on a free key.
    await db().client.pricingRule.updateMany({
      where: { cityCode: 'GLOBAL' },
      data: { isActive: false },
    });
  });
  afterEach(async () => {
    // resetState reseeds vehicle types but leaves isActive alone, so undo any retiring here.
    await db().client.vehicleType.updateMany({
      where: { code: { in: RETIRED_IN_TESTS } },
      data: { isActive: true },
    });
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
      vehicleType: CAR_A.code,
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
    assert.equal(rule.vehicleType, CAR_A.code);
    assert.equal(rule.vehicleTypeCode, CAR_A.code);
    assert.equal(rule.vehicleTypeId, await vehicleTypeId(CAR_A.code));
    assert.equal(rule.vehicleCategory, 'car');
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

  const retire = (code: string) =>
    db().client.vehicleType.update({ where: { code }, data: { isActive: false } });

  it('refuses a new fare on a retired vehicle type, which no ride can use', async () => {
    const authHeader = await loginAdmin();
    await retire('CAB_MINI_AC');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({ vehicleType: 'CAB_MINI_AC' }),
    });
    assert.equal(created.statusCode, 409, created.payload);
    // VehicleTypeService's shared refusal for a retired type.
    assert.equal(created.json().error.code, 'VEHICLE_TYPE_INACTIVE');
  });

  it('never moves an edited rule onto a retired type, and the rule keeps its fare', async () => {
    const authHeader = await loginAdmin();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({ vehicleType: 'CAB_MINI_AC' }),
    });
    assert.equal(created.statusCode, 201, created.payload);
    const id = created.json().data.id as string;
    await retire('CAB_XL_AC');

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${id}`,
      headers: authHeader,
      payload: { vehicleType: 'CAB_XL_AC', baseFare: 75 },
    });
    assert.equal(moved.statusCode, 409, moved.payload);
    const row = await db().client.pricingRule.findUniqueOrThrow({
      where: { id },
      include: { vehicleType: true },
    });
    assert.equal(row.isActive, true);
    assert.equal(row.vehicleType.code, 'CAB_MINI_AC');
  });

  it('still edits a rule whose own vehicle type was retired', async () => {
    const authHeader = await loginAdmin();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: basePayload({ vehicleType: 'CAB_MINI_AC' }),
    });
    assert.equal(created.statusCode, 201, created.payload);
    await retire('CAB_MINI_AC');

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${created.json().data.id as string}`,
      headers: authHeader,
      payload: { vehicleType: 'CAB_MINI_AC', status: 'inactive' },
    });
    assert.equal(edited.statusCode, 200, edited.payload);
    assert.equal(edited.json().data.vehicleTypeCode, 'CAB_MINI_AC');
    assert.equal(edited.json().data.status, 'inactive');
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

    const secondPayload = basePayload({ cityCode: 'SGR', serviceType: 'instant', baseFare: 65 });
    // A second active rule on the same key is refused, never silently clobbered.
    const clash = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: secondPayload,
    });
    assert.equal(clash.statusCode, 409, clash.payload);
    assert.equal(clash.json().error.code, 'FARE_RULE_CONFLICT');

    // Staged inactive, then activated: that retires the prior active rule.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers: authHeader,
      payload: { ...secondPayload, status: 'inactive' },
    });
    assert.equal(second.statusCode, 201, second.payload);
    const activatedSecond = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fare-rules/${second.json().data.id as string}/activate`,
      headers: authHeader,
    });
    assert.equal(activatedSecond.statusCode, 200, activatedSecond.payload);

    const firstRow = await db().client.pricingRule.findUniqueOrThrow({ where: { id: firstId } });
    assert.equal(firstRow.isActive, false);
    assert.equal(activatedSecond.json().data.status, 'active');

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
  describe('exact vehicle types (no alias map)', () => {
    async function create(authHeader: Record<string, string>, overrides: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/admin/fare-rules',
        headers: authHeader,
        payload: basePayload(overrides),
      });
    }

    it('keeps two cab variants on the same key as two separate rules, and editing one leaves the other', async () => {
      const authHeader = await loginAdmin();
      const idA = await vehicleTypeId(CAR_A.code);
      const idB = await vehicleTypeId(CAR_B.code);
      await ensureCity('SGR', 'Srinagar', 'Jammu & Kashmir');
      const sgr = { vehicleType: undefined, cityCode: 'SGR' };

      const a = await create(authHeader, { ...sgr, vehicleTypeId: idA, baseFare: 41 });
      const b = await create(authHeader, { ...sgr, vehicleTypeId: idB, baseFare: 52 });
      assert.equal(a.statusCode, 201, a.payload);
      assert.equal(b.statusCode, 201, b.payload);
      assert.equal(a.json().data.vehicleTypeId, idA);
      assert.equal(b.json().data.vehicleTypeId, idB);

      // Both stay in force: different exact types never share an exclusivity key.
      const active = await db().client.pricingRule.findMany({
        where: { isActive: true, cityCode: 'SGR' },
      });
      assert.deepEqual(new Set(active.map((r) => r.vehicleTypeId)), new Set([idA, idB]));

      // An edit that does not name a type keeps the rule's own type.
      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/fare-rules/${a.json().data.id as string}`,
        headers: authHeader,
        payload: { baseFare: 43 },
      });
      assert.equal(edited.statusCode, 200, edited.payload);
      assert.equal(edited.json().data.vehicleTypeId, idA);
      const bRow = await db().client.pricingRule.findUniqueOrThrow({
        where: { id: b.json().data.id as string },
      });
      assert.equal(bRow.isActive, true);
      assert.equal(Number(bRow.baseFare), 52);
    });

    it('refuses the generic "cab" instead of guessing a variant', async () => {
      const authHeader = await loginAdmin();
      const before = await db().client.pricingRule.count();
      const res = await create(authHeader, { vehicleType: 'cab' });
      assert.equal(res.statusCode, 404, res.payload);
      assert.equal(res.json().error.code, 'VEHICLE_TYPE_NOT_FOUND');
      assert.equal(await db().client.pricingRule.count(), before);
    });

    it('refuses an unknown id, and an id whose code disagrees', async () => {
      const authHeader = await loginAdmin();
      const unknown = await create(authHeader, {
        vehicleType: undefined,
        vehicleTypeId: '00000000-0000-7000-8000-000000000000',
      });
      assert.equal(unknown.statusCode, 404, unknown.payload);
      const mismatch = await create(authHeader, {
        vehicleType: CAR_B.code,
        vehicleTypeId: await vehicleTypeId(CAR_A.code),
      });
      assert.equal(mismatch.statusCode, 404, mismatch.payload);
    });

    it('requires a vehicle type on create', async () => {
      const authHeader = await loginAdmin();
      const res = await create(authHeader, { vehicleType: undefined });
      assert.equal(res.statusCode, 400, res.payload);
    });

    it('refuses a new rule on a retired type but still lets its existing rule be edited', async () => {
      const authHeader = await loginAdmin();
      const idA = await vehicleTypeId(CAR_A.code);
      const existing = await create(authHeader, { vehicleType: undefined, vehicleTypeId: idA });
      assert.equal(existing.statusCode, 201, existing.payload);
      await db().client.vehicleType.update({ where: { id: idA }, data: { isActive: false } });

      const fresh = await create(authHeader, {
        vehicleType: undefined,
        vehicleTypeId: idA,
        cityCode: 'GLOBAL',
        effectiveFrom: `${new Date().getFullYear() + 2}-01-01`,
      });
      assert.equal(fresh.statusCode, 409, fresh.payload);
      assert.equal(fresh.json().error.code, 'VEHICLE_TYPE_INACTIVE');

      const edited = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/fare-rules/${existing.json().data.id as string}`,
        headers: authHeader,
        payload: { vehicleTypeId: idA, baseFare: 70 },
      });
      assert.equal(edited.statusCode, 200, edited.payload);
      assert.equal(edited.json().data.vehicleTypeId, idA);
    });
  });
});
