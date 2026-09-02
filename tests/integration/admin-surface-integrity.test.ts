import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  createPricingRuleDirect,
  ensureCity,
  ensureCityWithBoundary,
  grantRole,
  vehicleTypeIdByCode,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545071';
const ADMIN_EMAIL = 'surface-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

/// A city-sized polygon, and a zone that sits well inside it.
const CITY_POLYGON: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

const INSIDE_POLYGON: number[][][] = [
  [
    [74.8, 34.05],
    [74.85, 34.05],
    [74.85, 34.1],
    [74.8, 34.1],
    [74.8, 34.05],
  ],
];

/// Overlaps the city but reaches beyond its eastern edge.
const STRADDLING_POLYGON: number[][][] = [
  [
    [74.9, 34.05],
    [75.4, 34.05],
    [75.4, 34.1],
    [74.9, 34.1],
    [74.9, 34.05],
  ],
];

/// Phase 6. The admin surface is the only way a rate card, a boundary or a surge
/// window comes into existence, so a defect here is not an admin inconvenience:
/// it is a wrong price, a city that serves nothing, or a change nobody can trace.
describe('admin surface integrity (Phase 6)', () => {
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
    return {
      headers: { authorization: `Bearer ${loggedIn.json().accessToken}` },
      userId: seed.userId,
    };
  }

  async function auditRows(entityType: string) {
    return db().client.adminActivityLog.findMany({
      where: { entityType },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ---------------------------------------------------------------- FR-029 --
  describe('a city code cannot be renamed out from under its references (FR-029)', () => {
    it('rejects a code change and leaves the fare rule resolvable', async () => {
      const { headers } = await loginAdmin();
      const cityId = await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
      const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
      await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 99 });

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/geographic/cities/${cityId}`,
        headers,
        payload: { code: 'SXR' },
      });

      // `pricing_rules.city_code` is a plain string with no foreign key. A
      // successful rename would leave the rule pointing at a city code that no
      // longer exists — and that is not an error anywhere: the rule simply stops
      // resolving and the city silently falls back to GLOBAL pricing.
      assert.equal(renamed.statusCode, 409, renamed.payload);

      const city = await db().client.city.findUnique({ where: { id: cityId } });
      assert.equal(city?.code, 'SGR');
      const rules = await db().client.pricingRule.findMany({ where: { cityCode: 'SGR' } });
      assert.equal(rules.length, 1);
    });

    it('accepts a no-op code, so a full-object PATCH still works', async () => {
      const { headers } = await loginAdmin();
      const cityId = await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/geographic/cities/${cityId}`,
        headers,
        payload: { code: 'sgr', name: 'Srinagar City' },
      });
      assert.equal(patched.statusCode, 200, patched.payload);
      assert.equal(patched.json().data.name, 'Srinagar City');
    });
  });

  // ---------------------------------------------------------------- FR-030 --
  it('refuses to activate a city that has no boundary (FR-030)', async () => {
    const { headers } = await loginAdmin();
    // `ensureCity` cannot set a boundary — Prisma cannot write the geography
    // column — which is exactly the state under test.
    const cityId = await ensureCity('BLR', 'Bengaluru');
    await db().client.city.update({ where: { id: cityId }, data: { isActive: false } });

    const activated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/geographic/cities/${cityId}`,
      headers,
      payload: { isActive: true },
    });

    // The old guard required `body.boundary` to be both null and undefined, so
    // it never ran. An active city with no polygon contains no point, resolves
    // no zone, and serves nobody — while appearing live in the admin list.
    assert.equal(activated.statusCode, 400, activated.payload);
    assert.match(activated.json().error?.message ?? '', /boundary/i);

    const city = await db().client.city.findUnique({ where: { id: cityId } });
    assert.equal(city?.isActive, false);
  });

  it('activates a city once it has a boundary (FR-030)', async () => {
    const { headers } = await loginAdmin();
    const cityId = await ensureCityWithBoundary('BLR', 'Bengaluru', CITY_POLYGON);
    await db().client.city.update({ where: { id: cityId }, data: { isActive: false } });

    const activated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/geographic/cities/${cityId}`,
      headers,
      payload: { isActive: true },
    });
    assert.equal(activated.statusCode, 200, activated.payload);
    assert.equal(activated.json().data.isActive, true);
  });

  // ---------------------------------------------------------------- FR-042 --
  describe('containment is asserted, not assumed (FR-042)', () => {
    it('refuses a zone against a city with no boundary', async () => {
      const { headers } = await loginAdmin();
      await ensureCity('BLR', 'Bengaluru');

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/geographic/service-zones',
        headers,
        payload: {
          cityCode: 'BLR',
          code: 'BLR_ANYWHERE',
          name: 'Anywhere',
          zoneType: 'SERVICE',
          coordinates: INSIDE_POLYGON,
        },
      });

      // The containment query filtered on `boundary IS NOT NULL`, so a
      // boundary-less city returned zero rows and the `rows.length > 0` guard
      // skipped the check entirely. The zone could be drawn anywhere on Earth
      // and the operator was told the boundary had been verified.
      assert.equal(created.statusCode, 400, created.payload);
      assert.match(created.json().error?.message ?? '', /within city boundary/i);

      const zones = await db().client.serviceZone.findMany({ where: { code: 'BLR_ANYWHERE' } });
      assert.equal(zones.length, 0);
    });

    it('still refuses a zone that escapes a real boundary', async () => {
      const { headers } = await loginAdmin();
      await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/geographic/service-zones',
        headers,
        payload: {
          cityCode: 'SGR',
          code: 'SGR_STRADDLE',
          name: 'Straddling',
          zoneType: 'SERVICE',
          coordinates: STRADDLING_POLYGON,
        },
      });
      assert.equal(created.statusCode, 400, created.payload);
    });
  });

  // ------------------------------------------------------- FR-031 / FR-035 --
  it('creates a zone, its vehicle links and its audit row together (FR-031, FR-035)', async () => {
    const { headers, userId } = await loginAdmin();
    await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
    const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/geographic/service-zones',
      headers,
      payload: {
        cityCode: 'SGR',
        code: 'SGR_CORE',
        name: 'Core',
        zoneType: 'SERVICE',
        coordinates: INSIDE_POLYGON,
        vehicleTypeIds: [vehicleTypeId],
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const zone = created.json().data;
    assert.deepEqual(zone.vehicleTypeIds, [vehicleTypeId]);

    const audits = await auditRows('service_zone');
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actorId, userId);
    assert.equal(audits[0]?.action, 'CREATE');
    assert.equal(audits[0]?.entityId, zone.id);
    const after = (audits[0]?.metadata as { after?: { code?: string } } | null)?.after;
    assert.equal(after?.code, 'SGR_CORE');
  });

  it('records who changed a city, and what it looked like before (FR-035)', async () => {
    const { headers, userId } = await loginAdmin();
    const cityId = await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/geographic/cities/${cityId}`,
      headers,
      payload: { name: 'Srinagar (Winter Capital)' },
    });
    assert.equal(patched.statusCode, 200, patched.payload);

    const audits = await auditRows('city');
    const update = audits.find((row) => row.action === 'UPDATE');
    assert.ok(update, 'expected an UPDATE audit row');
    assert.equal(update.actorId, userId);
    const meta = update.metadata as {
      before?: { name?: string };
      after?: { name?: string };
    } | null;
    assert.equal(meta?.before?.name, 'Srinagar');
    assert.equal(meta?.after?.name, 'Srinagar (Winter Capital)');
  });

  // ---------------------------------------------------------------- FR-033 --
  describe('a mutation against something that does not exist is a 404 (FR-033)', () => {
    const MISSING = '00000000-0000-4000-8000-000000000000';

    it('surge zone update', async () => {
      const { headers } = await loginAdmin();
      // The raw `UPDATE ... WHERE id = $1` matched no rows, reported nothing,
      // and the controller sent `{ success: true }` — so an operator editing a
      // zone that had been deleted was told the edit landed.
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/pricing/surge-zones/${MISSING}`,
        headers,
        payload: { name: 'Ghost' },
      });
      assert.equal(res.statusCode, 404, res.payload);
    });

    it('surge window update', async () => {
      const { headers } = await loginAdmin();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/pricing/surge-windows/${MISSING}`,
        headers,
        payload: { multiplier: 1.5 },
      });
      assert.equal(res.statusCode, 404, res.payload);
    });
  });

  // ---------------------------------------------------------------- FR-032 --
  it('refuses an invalid surge polygon on create, not only on update (FR-032)', async () => {
    const { headers } = await loginAdmin();

    // A bow-tie: the ring crosses itself. `ST_IsValid` is false, and every
    // later `ST_Intersects` against it raises — turning a bad admin input into
    // a failure inside the surge lookup on the booking path.
    const selfIntersecting: number[][][] = [
      [
        [74.7, 34.0],
        [75.0, 34.2],
        [75.0, 34.0],
        [74.7, 34.2],
        [74.7, 34.0],
      ],
    ];

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/pricing/surge-zones',
      headers,
      payload: { cityCode: 'SGR', name: 'Bowtie', coordinates: selfIntersecting },
    });
    assert.notEqual(created.statusCode, 201, created.payload);

    const zones = await db().client.surgeZone.findMany({ where: { name: 'Bowtie' } });
    assert.equal(zones.length, 0, 'an invalid polygon must not reach the table');
  });

  // ---------------------------------------------------------------- FR-034 --
  describe('one active rule per key is decided by the database (FR-034)', () => {
    it('rejects a concurrent second active rule on the same key', async () => {
      await loginAdmin();
      const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
      await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);

      // Both inserts race with no read between them, which is what two admins
      // saving the same key at once actually looks like. The application's
      // deactivate-then-insert cannot see the other transaction; the partial
      // unique index can.
      const results = await Promise.allSettled([
        createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 100 }),
        createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 200 }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 1, 'exactly one active rule may survive the race');

      const active = await db().client.pricingRule.findMany({
        where: { cityCode: 'SGR', vehicleTypeId, isActive: true },
      });
      assert.equal(active.length, 1);
    });

    it('still allows an inactive version history on the same key', async () => {
      await loginAdmin();
      const vehicleTypeId = await vehicleTypeIdByCode('CAB_ECONOMY');
      await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);

      await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 100 });
      await createPricingRuleDirect({
        vehicleTypeId,
        cityCode: 'SGR',
        baseFare: 90,
        isActive: false,
      });
      await createPricingRuleDirect({
        vehicleTypeId,
        cityCode: 'SGR',
        baseFare: 80,
        isActive: false,
      });

      const all = await db().client.pricingRule.findMany({ where: { cityCode: 'SGR' } });
      assert.equal(all.length, 3, 'superseded versions must remain readable');
    });

    it('an edit that revises a rule leaves exactly one active version', async () => {
      const { headers } = await loginAdmin();
      const cab = await vehicleTypeIdByCode('CAB_ECONOMY');
      const nextYear = new Date().getFullYear() + 1;

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/fare-rules',
        headers,
        payload: {
          vehicleType: 'cab',
          cityCode: 'GLOBAL',
          baseFare: 60,
          minimumFare: 80,
          perKmRate: 15,
          perMinuteRate: 1.5,
          effectiveFrom: `${nextYear}-01-01`,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);

      const updated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/fare-rules/${created.json().data.id}`,
        headers,
        payload: { baseFare: 75 },
      });
      assert.equal(updated.statusCode, 200, updated.payload);
      assert.equal(updated.json().data.baseFare, 75);
      assert.equal(updated.json().data.version, 2);

      // `resetState` re-seeds one GLOBAL rule per vehicle type, so the count is
      // scoped to the key under test — and that seeded CAB_ECONOMY rule is the
      // incumbent the create had to retire, which makes this the real case.
      const active = await db().client.pricingRule.findMany({
        where: { cityCode: 'GLOBAL', vehicleTypeId: cab, isActive: true },
      });
      assert.equal(active.length, 1, 'the revision replaces the incumbent, it does not join it');
      assert.equal(Number(active[0]?.baseFare), 75);
    });
  });

  // ---------------------------------------------------------------- FR-036 --
  it('accepts any vehicle type the table knows about (FR-036)', async () => {
    const { headers } = await loginAdmin();
    // `CAB_PREMIUM` was rejected by a hardcoded enum while the same file's
    // `CODE_TO_UI` map already knew how to render it. Creating a category made
    // it impossible to price.
    await vehicleTypeIdByCode('CAB_PREMIUM');
    const nextYear = new Date().getFullYear() + 1;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleType: 'CAB_PREMIUM',
        cityCode: 'GLOBAL',
        baseFare: 120,
        minimumFare: 150,
        perKmRate: 25,
        perMinuteRate: 3,
        effectiveFrom: `${nextYear}-01-01`,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    assert.equal(created.json().data.vehicleTypeCode, 'CAB_PREMIUM');
  });

  it('rejects a vehicle type that is not in the table (FR-036)', async () => {
    const { headers } = await loginAdmin();
    const nextYear = new Date().getFullYear() + 1;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleType: 'HELICOPTER',
        cityCode: 'GLOBAL',
        baseFare: 120,
        minimumFare: 150,
        perKmRate: 25,
        perMinuteRate: 3,
        effectiveFrom: `${nextYear}-01-01`,
      },
    });
    // Loosening the schema must not loosen the check — it moves it to the table.
    assert.equal(created.statusCode, 409, created.payload);
  });

  // ---------------------------------------------------------------- FR-040 --
  it('paginates and filters fare rules in the database (FR-040)', async () => {
    const { headers } = await loginAdmin();
    const cab = await vehicleTypeIdByCode('CAB_ECONOMY');
    const auto = await vehicleTypeIdByCode('AUTO');
    const bike = await vehicleTypeIdByCode('BIKE');
    await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
    await ensureCityWithBoundary('JMU', 'Jammu', CITY_POLYGON);

    await createPricingRuleDirect({ vehicleTypeId: cab, cityCode: 'SGR', baseFare: 10 });
    await createPricingRuleDirect({ vehicleTypeId: auto, cityCode: 'SGR', baseFare: 20 });
    await createPricingRuleDirect({ vehicleTypeId: bike, cityCode: 'SGR', baseFare: 15 });
    await createPricingRuleDirect({ vehicleTypeId: cab, cityCode: 'JMU', baseFare: 30 });

    // Scoped to SGR because `resetState` re-seeds a GLOBAL rule per vehicle
    // type; the point of the test is that the counts come from the database, not
    // that the table is empty.
    const page = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules?cityCode=SGR&page=1&limit=2',
      headers,
    });
    assert.equal(page.statusCode, 200, page.payload);
    const body = page.json();
    // `totalCount` used to be the length of an array the server had already
    // built in memory, so it agreed with the page by construction. It now comes
    // from a `count` and has to agree on its own.
    assert.equal(body.data.length, 2);
    assert.equal(body.meta.totalCount, 3);
    assert.equal(body.meta.totalPages, 2);

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules?cityCode=SGR&page=2&limit=2',
      headers,
    });
    assert.equal(second.json().data.length, 1);

    const searched = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules?cityCode=SGR&search=AUTO',
      headers,
    });
    assert.equal(searched.statusCode, 200, searched.payload);
    assert.equal(searched.json().meta.totalCount, 1);
    assert.equal(searched.json().data[0].vehicleTypeCode, 'AUTO');

    const byCity = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules?cityCode=JMU',
      headers,
    });
    assert.equal(byCity.json().meta.totalCount, 1);

    // Three SGR rules plus the re-seeded GLOBAL catalog: the unscoped count has
    // to come from the database too, not from the length of the page.
    const unscoped = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules?page=1&limit=1',
      headers,
    });
    assert.equal(unscoped.json().data.length, 1);
    assert.ok(unscoped.json().meta.totalCount > 1);
  });

  // ------------------------------------------------------- FR-035 (pricing) --
  it('records the actor and the full before/after of a fare-rule revision (FR-035)', async () => {
    const { headers, userId } = await loginAdmin();
    await vehicleTypeIdByCode('CAB_ECONOMY');
    const nextYear = new Date().getFullYear() + 1;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleType: 'cab',
        cityCode: 'GLOBAL',
        baseFare: 60,
        minimumFare: 80,
        perKmRate: 15,
        perMinuteRate: 1.5,
        effectiveFrom: `${nextYear}-01-01`,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${created.json().data.id}`,
      headers,
      payload: { baseFare: 75 },
    });
    assert.equal(updated.statusCode, 200, updated.payload);

    const audits = await auditRows('pricing_rule');
    assert.equal(audits.length, 2, 'the create and the revision are both recorded');
    assert.equal(audits[0]?.action, 'CREATE');
    assert.equal(audits[1]?.action, 'UPDATE');
    assert.equal(audits[1]?.actorId, userId);

    // Constitution 17.4: a staff change to what customers are charged has to say
    // who made it and what it replaced. A price is money.
    const meta = audits[1]?.metadata as {
      before?: { baseFare?: number };
      after?: { baseFare?: number };
    } | null;
    assert.equal(meta?.before?.baseFare, 60);
    assert.equal(meta?.after?.baseFare, 75);
  });

  it('writes no audit row when the mutation is rejected (FR-031, FR-035)', async () => {
    const { headers } = await loginAdmin();
    await ensureCity('BLR', 'Bengaluru');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/geographic/service-zones',
      headers,
      payload: {
        cityCode: 'BLR',
        code: 'BLR_REJECTED',
        name: 'Rejected',
        zoneType: 'SERVICE',
        coordinates: INSIDE_POLYGON,
      },
    });
    assert.equal(created.statusCode, 400, created.payload);

    // An audit trail that records changes which did not happen is worse than
    // none: it is evidence for something untrue.
    const audits = await auditRows('service_zone');
    assert.equal(audits.length, 0);
  });
});
