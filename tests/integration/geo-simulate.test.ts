import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  completeProfile,
  createPricingRuleDirect,
  ensureCity,
  ensureCityWithBoundary,
  grantRole,
} from './helpers/fixtures.js';

const box = (w: number, s: number, e: number, n: number): number[][][] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];

const CITY = box(74.7, 34.0, 75.0, 34.2);
const ZONE = box(74.72, 34.02, 74.76, 34.06);
const IN_ZONE = { lat: 34.04, lng: 74.74 };
const ELSEWHERE = { lat: 34.15, lng: 74.9 };
const OUTSIDE_CITY = { lat: 12.97, lng: 77.59 };
const DROP = { dropLat: 34.1, dropLng: 74.85 };
const SIMULATE = '/api/v1/admin/geographic/simulate';
const CITIES = '/api/v1/admin/geographic/cities';

type ZoneType = 'SERVICE' | 'AIRPORT' | 'RESTRICTED';
interface Options {
  pickup?: boolean;
  drop?: boolean;
  active?: boolean;
  message?: string;
  vehicles?: string[];
}

describe('test a point, city checklist and rider check (integration)', () => {
  let app: FastifyInstance;
  let admin: LoggedInUser;
  let rider: LoggedInUser;
  let cityId: string;
  let cabId: string;
  let bikeId: string;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    cityId = await ensureCityWithBoundary('SGR', 'Srinagar', CITY);
    cabId = (
      await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY_NON_AC' } })
    ).id;
    bikeId = (await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'BIKE' } })).id;
    admin = await loginAs(app, '+919876730001');
    await grantRole(admin.userId, 'system_admin');
    rider = await loginAs(app, '+919876730002');
    await completeProfile(rider.userId);
  });
  afterEach(async () => {
    await resetState();
  });

  async function addZone(
    code: string,
    zoneType: ZoneType,
    boundary: number[][][],
    options: Options = {},
  ): Promise<string> {
    const geoJson = JSON.stringify({ type: 'Polygon', coordinates: boundary });
    const rows = await db().client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO service_zones (
        id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff,
        rider_message, is_active, created_at, updated_at
      )
      SELECT gen_random_uuid(), c.id, ${code}, ${code}, ${zoneType}::"ServiceZoneType",
        ST_GeomFromGeoJSON(${geoJson}), ${options.pickup ?? true}, ${options.drop ?? true},
        ${options.message ?? null}, ${options.active ?? true}, NOW(), NOW()
      FROM cities c WHERE c.code = 'SGR'
      RETURNING id
    `;
    const id = rows[0]!.id;
    for (const vehicleTypeId of options.vehicles ?? []) {
      await db().client.serviceZoneVehicleType.create({
        data: { serviceZoneId: id, vehicleTypeId },
      });
    }
    return id;
  }

  const setMode = (mode: 'WHOLE_CITY' | 'ZONES_ONLY') =>
    db().client.city.update({ where: { code: 'SGR' }, data: { coverageMode: mode } });

  async function simulate(
    point: { lat: number; lng: number },
    extra: Record<string, string | number> = {},
    who: LoggedInUser = admin,
  ) {
    const query = new URLSearchParams(
      Object.entries({ ...point, ...extra }).map(([k, v]) => [k, String(v)]),
    );
    return app.inject({
      method: 'GET',
      url: `${SIMULATE}?${query.toString()}`,
      headers: who.authHeader,
    });
  }

  async function quote(point: { lat: number; lng: number }, vehicleTypeId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/rides/quote',
      headers: rider.authHeader,
      payload: { pickupLat: point.lat, pickupLng: point.lng, ...DROP, vehicleTypeId },
    });
  }

  const quoteCode = (res: { json(): Record<string, unknown> }): string | undefined => {
    const body = res.json() as { code?: string; error?: { code?: string } };
    return body.error?.code ?? body.code;
  };

  describe('Test a Point matches what a rider really gets', () => {
    const scenarios: Array<{
      name: string;
      point: { lat: number; lng: number };
      vehicle?: 'bike';
      setup?: () => Promise<unknown>;
      refusal: string | null;
    }> = [
      { name: 'whole city, no zone', point: ELSEWHERE, refusal: null },
      {
        name: 'whole city, an airport zone elsewhere',
        point: ELSEWHERE,
        setup: () => addZone('SGR_AP', 'AIRPORT', ZONE),
        refusal: null,
      },
      {
        name: 'zones only, outside the zones',
        point: ELSEWHERE,
        setup: async () => {
          await setMode('ZONES_ONLY');
          await addZone('SGR_SZ', 'SERVICE', ZONE);
        },
        refusal: 'OUTSIDE_SERVICE_ZONE',
      },
      {
        name: 'zones only, last zone deactivated',
        point: IN_ZONE,
        setup: async () => {
          await setMode('ZONES_ONLY');
          await addZone('SGR_SZ', 'SERVICE', ZONE, { active: false });
        },
        refusal: 'OUTSIDE_SERVICE_ZONE',
      },
      {
        name: 'restricted, pickup blocked',
        point: IN_ZONE,
        setup: () => addZone('SGR_RZ', 'RESTRICTED', ZONE, { pickup: false }),
        refusal: 'RESTRICTED_ZONE',
      },
      {
        name: 'drop-only airport',
        point: IN_ZONE,
        setup: () => addZone('SGR_AP', 'AIRPORT', ZONE, { pickup: false }),
        refusal: 'OUTSIDE_SERVICE_ZONE',
      },
      { name: 'outside every city', point: OUTSIDE_CITY, refusal: 'OUTSIDE_SERVICE_AREA' },
      {
        name: 'vehicle not allowed in the zone',
        point: IN_ZONE,
        vehicle: 'bike',
        setup: () => addZone('SGR_SZ', 'SERVICE', ZONE, { vehicles: [cabId] }),
        refusal: 'VEHICLE_NOT_SUPPORTED_IN_ZONE',
      },
      {
        name: 'drop point in a restricted zone',
        point: ELSEWHERE,
        setup: () =>
          addZone('SGR_RZ', 'RESTRICTED', box(74.84, 34.09, 74.86, 34.11), { drop: false }),
        refusal: 'RESTRICTED_ZONE',
      },
    ];

    for (const scenario of scenarios) {
      it(scenario.name, async () => {
        await scenario.setup?.();
        const vehicleTypeId = scenario.vehicle === 'bike' ? bikeId : cabId;

        const simulated = await simulate(scenario.point, { ...DROP, vehicleTypeId });
        assert.equal(simulated.statusCode, 200, simulated.payload);
        const data = simulated.json().data;
        const refusal = data.pickup.refusal ?? data.drop?.refusal ?? data.vehicle?.refusal ?? null;
        assert.equal(refusal, scenario.refusal);

        const real = await quote(scenario.point, vehicleTypeId);
        if (scenario.refusal === null) {
          assert.equal(real.statusCode, 200, real.payload);
        } else {
          assert.notEqual(real.statusCode, 200, real.payload);
          assert.equal(quoteCode(real), scenario.refusal);
        }
      });
    }

    it('reports the same fare and surge a quote charges', async () => {
      const zoneId = await addZone('SGR_SZ', 'SERVICE', ZONE);
      await createPricingRuleDirect({
        vehicleTypeId: cabId,
        cityCode: 'SGR',
        baseFare: 120,
        serviceZoneId: zoneId,
      });
      await db().client.surgeWindow.create({
        data: {
          serviceZoneId: zoneId,
          multiplier: 1.5,
          startsAt: new Date(Date.now() - 3_600_000),
        },
      });

      const simulated = await simulate(IN_ZONE, { ...DROP, vehicleTypeId: cabId });
      const data = simulated.json().data;
      assert.equal(data.fare.scope, 'ZONE');
      assert.equal(data.fare.baseFare, 120);
      assert.equal(data.surge.multiplier, 1.5);

      const real = await quote(IN_ZONE, cabId);
      assert.equal(real.statusCode, 200, real.payload);
      const body = real.json().data as {
        options?: Array<{ vehicleTypeId: string; fareBreakdown: { surgeMultiplier: number } }>;
        fareBreakdown?: { surgeMultiplier: number };
      };
      const option = body.options?.find((o) => o.vehicleTypeId === cabId) ?? body;
      assert.equal(Number(option.fareBreakdown?.surgeMultiplier), 1.5);
    });

    it('answers for a chosen time, so a Saturday rule can be checked on any day', async () => {
      const zoneId = await addZone('SGR_SZ', 'SERVICE', ZONE);
      await db().client.surgeWindow.create({
        data: {
          serviceZoneId: zoneId,
          multiplier: 1.5,
          startsAt: new Date('2026-01-01T00:00:00Z'),
          isPeakHourOnly: true,
          peakHourStart: '22:00',
          peakHourEnd: '02:00',
          daysOfWeek: [6],
        },
      });
      // 7 November 2026 is a Saturday.
      const ask = async (at: string) =>
        (await simulate(IN_ZONE, { vehicleTypeId: cabId, at })).json().data.surge.multiplier;

      assert.equal(await ask('2026-11-07T23:00:00+05:30'), 1.5);
      assert.equal(await ask('2026-11-08T01:00:00+05:30'), 1.5);
      assert.equal(await ask('2026-11-07T01:00:00+05:30'), 1);
      assert.equal(await ask('2026-11-08T23:00:00+05:30'), 1);
    });

    it('lists the zones at the point, and leaves pricing out without pricing:read', async () => {
      await addZone('SGR_SZ', 'SERVICE', ZONE);

      const viewer = await loginAs(app, '+919876730003');
      const permission = await db().client.permission.findUniqueOrThrow({
        where: { code: 'geography:read' },
      });
      const role = await db().client.role.upsert({
        where: { slug: 'geo_viewer_test' },
        update: {},
        create: { slug: 'geo_viewer_test', name: 'Geo viewer' },
      });
      await db().client.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
      await grantRole(viewer.userId, 'geo_viewer_test');

      const res = await simulate(IN_ZONE, { vehicleTypeId: cabId }, viewer);
      assert.equal(res.statusCode, 200, res.payload);
      const data = res.json().data;
      assert.deepEqual(
        data.zones.map((z: { code: string }) => z.code),
        ['SGR_SZ'],
      );
      assert.equal('fare' in data, false);
      assert.equal('surge' in data, false);
    });

    it('refuses a rider, and a bad point', async () => {
      assert.equal((await simulate(IN_ZONE, {}, rider)).statusCode, 403);
      assert.equal((await simulate({ lat: 999, lng: 74 })).statusCode, 400);
    });
  });

  describe('city checklist', () => {
    const setup = async (id = cityId) => {
      const res = await app.inject({
        method: 'GET',
        url: `${CITIES}/${id}/setup`,
        headers: admin.authHeader,
      });
      assert.equal(res.statusCode, 200, res.payload);
      return res.json().data as {
        area: { km2: number };
        coverageMode: string;
        coveredPct: number;
        zones: { service: number; airport: number; restricted: number };
        fares: Array<{ code: string; name: string; level: string }>;
        surgeActive: number;
        issues: Array<{ code: string; severity: string; message: string; href: string }>;
      };
    };
    const codes = (data: Awaited<ReturnType<typeof setup>>) => data.issues.map((i) => i.code);

    it('reports how much of the city rides can start in', async () => {
      await setMode('ZONES_ONLY');
      await addZone('SGR_HALF', 'SERVICE', box(74.7, 34.0, 74.85, 34.2));
      const data = await setup();
      assert.ok(Math.abs(data.coveredPct - 50) < 1, `covered ${data.coveredPct}%`);
      assert.ok(data.area.km2 > 500);
      assert.equal(data.zones.service, 1);
    });

    it('reports 100% for a whole-city city whatever zones it has', async () => {
      await setMode('WHOLE_CITY');
      await addZone('SGR_SMALL', 'SERVICE', ZONE);
      assert.equal((await setup()).coveredPct, 100);
    });

    it('is red when a zones-only city has no active zone', async () => {
      await setMode('ZONES_ONLY');
      const issue = (await setup()).issues.find((i) => i.code === 'ZONES_ONLY_NO_ZONES');
      assert.equal(issue?.severity, 'RED');
    });

    it('is red for a restricted zone that blocks nothing, and names it', async () => {
      await addZone('SGR_OLD_RZ', 'RESTRICTED', ZONE);
      const issue = (await setup()).issues.find((i) => i.code === 'RESTRICTED_BLOCKS_NOTHING');
      assert.equal(issue?.severity, 'RED');
      assert.match(issue?.message ?? '', /SGR_OLD_RZ/);
      assert.match(issue?.href ?? '', /service-zones/);
    });

    it('is red for a vehicle with no fare anywhere, and amber for one on the global fare', async () => {
      await db().client.pricingRule.updateMany({
        where: { vehicleTypeId: bikeId },
        data: { isActive: false },
      });
      await createPricingRuleDirect({ vehicleTypeId: cabId, cityCode: 'SGR', baseFare: 80 });

      const data = await setup();
      const noFare = data.issues.find((i) => i.code === 'NO_FARE');
      assert.equal(noFare?.severity, 'RED');
      assert.match(noFare?.href ?? '', /fare-rules\/new\?cityCode=SGR/);
      assert.equal(data.fares.find((f) => f.code === 'BIKE')?.level, 'NONE');
      assert.equal(data.fares.find((f) => f.code === 'CAB_ECONOMY_NON_AC')?.level, 'CITY');

      // AC and Non-AC share a name, so match whole list entries, not a substring.
      const cabLabel = data.fares.find((f) => f.code === 'CAB_ECONOMY_NON_AC')?.name;
      const globalOnly = data.issues.find((i) => i.code === 'GLOBAL_FARE_ONLY');
      assert.equal(globalOnly?.severity, 'AMBER');
      const listed = (globalOnly?.message ?? '').replace(/^[^:]*: /, '').replace(/\.$/, '');
      assert.ok(
        cabLabel && !listed.split(', ').includes(cabLabel),
        'it has a city fare of its own',
      );
    });

    it('is amber for an active zone outside the Operating Area', async () => {
      await addZone('SGR_FAR', 'AIRPORT', box(74.65, 33.9, 74.68, 33.93));
      const issue = (await setup()).issues.find((i) => i.code === 'ZONE_OUTSIDE_AREA');
      assert.equal(issue?.severity, 'AMBER');
      assert.match(issue?.message ?? '', /SGR_FAR/);
    });

    it('is red for a city with no boundary', async () => {
      const id = await ensureCity('NEW', 'New');
      assert.ok(codes(await setup(id)).includes('NO_BOUNDARY'));
    });

    it('counts surge rules in force, for a zone or the whole city', async () => {
      const zoneId = await addZone('SGR_SZ', 'SERVICE', ZONE);
      const startsAt = new Date(Date.now() - 3_600_000);
      await db().client.surgeWindow.create({
        data: { serviceZoneId: zoneId, multiplier: 1.5, startsAt },
      });
      await db().client.surgeWindow.create({
        data: { cityCode: 'SGR', multiplier: 1.2, startsAt },
      });
      await db().client.surgeWindow.create({
        data: {
          cityCode: 'SGR',
          multiplier: 1.2,
          startsAt,
          endsAt: new Date(Date.now() - 1000),
        },
      });
      assert.equal((await setup()).surgeActive, 2);
    });

    it('is clean for a city ready to go', async () => {
      assert.deepEqual(
        (await setup()).issues.filter((i) => i.severity === 'RED'),
        [],
      );
    });

    it('will not turn a city on with a red item, and allows it once fixed', async () => {
      await db().client.city.update({
        where: { id: cityId },
        data: { isActive: false, coverageMode: 'ZONES_ONLY' },
      });
      const turnOn = () =>
        app.inject({
          method: 'PATCH',
          url: `${CITIES}/${cityId}`,
          headers: admin.authHeader,
          payload: { isActive: true },
        });

      const refused = await turnOn();
      assert.equal(refused.statusCode, 409, refused.payload);
      assert.match(refused.payload, /no active zone/i);

      await db().client.city.update({
        where: { id: cityId },
        data: { coverageMode: 'WHOLE_CITY' },
      });
      const allowed = await turnOn();
      assert.equal(allowed.statusCode, 200, allowed.payload);
    });

    it('still lets a city with a red item stay on and be edited', async () => {
      await setMode('ZONES_ONLY');
      const res = await app.inject({
        method: 'PATCH',
        url: `${CITIES}/${cityId}`,
        headers: admin.authHeader,
        payload: { name: 'Srinagar City' },
      });
      assert.equal(res.statusCode, 200, res.payload);
    });
  });

  describe('rider pin check', () => {
    const check = (point: { lat: number; lng: number }, who: LoggedInUser | null = rider) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/rides/serviceability?lat=${point.lat}&lng=${point.lng}`,
        ...(who ? { headers: who.authHeader } : {}),
      });

    it('says yes where a ride can start', async () => {
      const res = await check(ELSEWHERE);
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(res.json().data, { serviceable: true, code: null, message: null });
    });

    it('gives the admin message, and nothing about the zone', async () => {
      await addZone('SGR_SECRET_RZ', 'RESTRICTED', ZONE, {
        pickup: false,
        message: 'No pickups near the cantonment.',
      });
      const res = await check(IN_ZONE);
      assert.equal(res.statusCode, 200, res.payload);
      assert.deepEqual(res.json().data, {
        serviceable: false,
        code: 'RESTRICTED_ZONE',
        message: 'No pickups near the cantonment.',
      });
      assert.doesNotMatch(res.payload, /SGR_SECRET_RZ|coordinates|boundary/);
    });

    it('says no outside every city', async () => {
      const res = await check(OUTSIDE_CITY);
      assert.equal(res.json().data.code, 'OUTSIDE_SERVICE_AREA');
    });

    it('needs a logged-in user and a real point', async () => {
      assert.equal((await check(IN_ZONE, null)).statusCode, 401);
      assert.equal((await check({ lat: 999, lng: 74 })).statusCode, 400);
    });
  });
});
