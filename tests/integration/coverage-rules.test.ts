import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { container } from '../../src/core/di.js';
import { GeographicCoverageService } from '../../src/modules/location/index.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { ensureCityWithBoundary } from './helpers/fixtures.js';

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
const OUTER = box(74.72, 34.02, 74.76, 34.06);
const INNER = box(74.73, 34.03, 74.75, 34.05);
const IN_ZONE = { lat: 34.04, lng: 74.74 };
const ELSEWHERE = { lat: 34.15, lng: 74.9 };
const OUTSIDE_CITY = { lat: 12.97, lng: 77.59 };

type ZoneType = 'SERVICE' | 'AIRPORT' | 'RESTRICTED' | 'SURGE';

describe('where rides can start and end (integration)', () => {
  let app: FastifyInstance;
  let coverage: GeographicCoverageService;
  let cabId: string;
  let bikeId: string;

  before(async () => {
    app = await bootApp();
    coverage = container.resolve<GeographicCoverageService>('geographicCoverageService');
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    await ensureCityWithBoundary('SGR', 'Srinagar', CITY);
    cabId = (
      await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY_NON_AC' } })
    ).id;
    bikeId = (await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'BIKE' } })).id;
  });
  afterEach(async () => {
    await resetState();
  });

  async function setMode(mode: 'WHOLE_CITY' | 'ZONES_ONLY') {
    await db().client.city.update({ where: { code: 'SGR' }, data: { coverageMode: mode } });
  }

  async function addZone(
    code: string,
    zoneType: ZoneType,
    boundary: number[][][],
    options: {
      pickup?: boolean;
      drop?: boolean;
      active?: boolean;
      message?: string;
      vehicles?: string[];
    } = {},
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

  const hasCode = (code: string) => (err: unknown) => {
    assert.equal((err as { code?: string }).code, code);
    return true;
  };

  describe('pickup', () => {
    it('allows anywhere in a whole-city city with no zones', async () => {
      await setMode('WHOLE_CITY');
      const decision = await coverage.evaluatePickup(ELSEWHERE.lat, ELSEWHERE.lng);
      assert.equal(decision.allowed, true);
      assert.equal(decision.refusal, null);
      assert.equal(decision.city?.code, 'SGR');
    });

    it('does not close a whole-city city when it gets its first airport zone', async () => {
      await setMode('WHOLE_CITY');
      await addZone('SGR_AP', 'AIRPORT', OUTER);
      const decision = await coverage.evaluatePickup(ELSEWHERE.lat, ELSEWHERE.lng);
      assert.equal(decision.allowed, true);
    });

    it('refuses outside the zones of a zones-only city', async () => {
      await setMode('ZONES_ONLY');
      await addZone('SGR_SZ', 'SERVICE', OUTER);
      const decision = await coverage.evaluatePickup(ELSEWHERE.lat, ELSEWHERE.lng);
      assert.equal(decision.allowed, false);
      assert.equal(decision.refusal, 'OUTSIDE_SERVICE_ZONE');
    });

    it('allows inside a zone of a zones-only city', async () => {
      await setMode('ZONES_ONLY');
      await addZone('SGR_SZ', 'SERVICE', OUTER);
      const decision = await coverage.evaluatePickup(IN_ZONE.lat, IN_ZONE.lng);
      assert.equal(decision.allowed, true);
    });

    it('closes a zones-only city when its last zone is deactivated, never reopening it', async () => {
      await setMode('ZONES_ONLY');
      await addZone('SGR_SZ', 'SERVICE', OUTER, { active: false });
      for (const point of [IN_ZONE, ELSEWHERE]) {
        const decision = await coverage.evaluatePickup(point.lat, point.lng);
        assert.equal(decision.refusal, 'OUTSIDE_SERVICE_ZONE');
      }
    });

    it('refuses inside a restricted zone in either mode, with the admin message', async () => {
      for (const mode of ['WHOLE_CITY', 'ZONES_ONLY'] as const) {
        await setMode(mode);
        await addZone(`SGR_SZ_${mode}`, 'SERVICE', CITY);
        await addZone(`SGR_RZ_${mode}`, 'RESTRICTED', OUTER, {
          pickup: false,
          message: 'No pickups near the cantonment.',
        });
        const decision = await coverage.evaluatePickup(IN_ZONE.lat, IN_ZONE.lng);
        assert.equal(decision.allowed, false);
        assert.equal(decision.refusal, 'RESTRICTED_ZONE');
        assert.equal(decision.message, 'No pickups near the cantonment.');
        await db().client.serviceZone.deleteMany({ where: { code: { contains: mode } } });
      }
    });

    it('refuses when a small restricted zone allows pickup but a larger one blocks it', async () => {
      await setMode('WHOLE_CITY');
      await addZone('SGR_SMALL', 'RESTRICTED', INNER, { pickup: true, drop: false });
      await addZone('SGR_LARGE', 'RESTRICTED', OUTER, { pickup: false });
      const decision = await coverage.evaluatePickup(IN_ZONE.lat, IN_ZONE.lng);
      assert.equal(decision.refusal, 'RESTRICTED_ZONE');
    });

    it('refuses at a drop-only airport in a whole-city city', async () => {
      await setMode('WHOLE_CITY');
      await addZone('SGR_AP', 'AIRPORT', OUTER, { pickup: false });
      const decision = await coverage.evaluatePickup(IN_ZONE.lat, IN_ZONE.lng);
      assert.equal(decision.refusal, 'OUTSIDE_SERVICE_ZONE');
    });

    it('ignores a surge area, in both modes', async () => {
      await addZone('SGR_SURGE', 'SURGE', OUTER);

      await setMode('WHOLE_CITY');
      assert.equal((await coverage.evaluatePickup(IN_ZONE.lat, IN_ZONE.lng)).allowed, true);

      await setMode('ZONES_ONLY');
      const decision = await coverage.evaluatePickup(IN_ZONE.lat, IN_ZONE.lng);
      assert.equal(decision.refusal, 'OUTSIDE_SERVICE_ZONE', 'a surge area is not coverage');
    });

    it('refuses outside every city once coverage exists', async () => {
      const decision = await coverage.evaluatePickup(OUTSIDE_CITY.lat, OUTSIDE_CITY.lng);
      assert.equal(decision.refusal, 'OUTSIDE_SERVICE_AREA');
      assert.equal(decision.city, null);
    });

    it('throws today’s error codes from the existing checks', async () => {
      await setMode('ZONES_ONLY');
      await addZone('SGR_SZ', 'SERVICE', INNER);
      await addZone('SGR_RZ', 'RESTRICTED', box(74.8, 34.1, 74.82, 34.12), { pickup: false });
      const asked = { vehicleTypeId: cabId };

      await assert.rejects(
        () => coverage.assertPickupServiceable({ ...OUTSIDE_CITY, ...asked }),
        hasCode('OUTSIDE_SERVICE_AREA'),
      );
      await assert.rejects(
        () => coverage.assertPickupServiceable({ ...ELSEWHERE, ...asked }),
        hasCode('OUTSIDE_SERVICE_ZONE'),
      );
      await assert.rejects(
        () => coverage.assertPickupServiceable({ lat: 34.11, lng: 74.81, ...asked }),
        hasCode('RESTRICTED_ZONE'),
      );
      await assert.rejects(
        () => coverage.resolvePickupContext(ELSEWHERE.lat, ELSEWHERE.lng),
        hasCode('OUTSIDE_SERVICE_ZONE'),
      );
    });

    it('puts the admin message on the error the rider sees', async () => {
      await addZone('SGR_RZ', 'RESTRICTED', OUTER, {
        pickup: false,
        message: 'No pickups near the cantonment.',
      });
      await assert.rejects(
        () => coverage.resolvePickupContext(IN_ZONE.lat, IN_ZONE.lng),
        /No pickups near the cantonment\./,
      );
    });
  });

  describe('vehicles', () => {
    it('admits every vehicle in a zone with no vehicle list, including one added later', async () => {
      await addZone('SGR_SZ', 'SERVICE', OUTER);
      for (const vehicleTypeId of [cabId, bikeId]) {
        const city = await coverage.assertPickupServiceable({ ...IN_ZONE, vehicleTypeId });
        assert.equal(city.code, 'SGR');
      }
    });

    it('refuses a vehicle a zone does not list, and admits one it does', async () => {
      await addZone('SGR_SZ', 'SERVICE', OUTER, { vehicles: [cabId] });
      await coverage.assertPickupServiceable({ ...IN_ZONE, vehicleTypeId: cabId });
      await assert.rejects(
        () => coverage.assertPickupServiceable({ ...IN_ZONE, vehicleTypeId: bikeId }),
        hasCode('VEHICLE_NOT_SUPPORTED_IN_ZONE'),
      );
    });

    it('applies no vehicle limit outside every zone of a whole-city city', async () => {
      await setMode('WHOLE_CITY');
      await addZone('SGR_SZ', 'SERVICE', OUTER, { vehicles: [cabId] });
      await coverage.assertPickupServiceable({ ...ELSEWHERE, vehicleTypeId: bikeId });
    });

    it('uses the smallest zone’s list when zones nest', async () => {
      await addZone('SGR_OUTER', 'SERVICE', OUTER, { vehicles: [cabId, bikeId] });
      await addZone('SGR_INNER', 'AIRPORT', INNER, { vehicles: [cabId] });
      await assert.rejects(
        () => coverage.assertPickupServiceable({ ...IN_ZONE, vehicleTypeId: bikeId }),
        hasCode('VEHICLE_NOT_SUPPORTED_IN_ZONE'),
      );
    });
  });

  describe('drop', () => {
    const drop = (point: { lat: number; lng: number }) => ({ ...point, cityCode: 'SGR' });

    it('allows a drop anywhere in the city, even outside the zones of a zones-only city', async () => {
      await setMode('ZONES_ONLY');
      await addZone('SGR_SZ', 'SERVICE', OUTER);
      const decision = await coverage.evaluateDrop(drop(ELSEWHERE));
      assert.equal(decision.allowed, true);
      await coverage.assertDropServiceable(drop(ELSEWHERE));
    });

    it('refuses inside a restricted zone that blocks drops, with the admin message', async () => {
      await addZone('SGR_RZ', 'RESTRICTED', OUTER, {
        pickup: true,
        drop: false,
        message: 'No drops near the cantonment.',
      });
      const decision = await coverage.evaluateDrop(drop(IN_ZONE));
      assert.equal(decision.refusal, 'RESTRICTED_ZONE');
      assert.equal(decision.message, 'No drops near the cantonment.');
      await assert.rejects(() => coverage.assertDropServiceable(drop(IN_ZONE)), hasCode('RESTRICTED_ZONE'));
    });

    it('refuses at an airport with drops off', async () => {
      await addZone('SGR_AP', 'AIRPORT', OUTER, { drop: false });
      await assert.rejects(
        () => coverage.assertDropServiceable(drop(IN_ZONE)),
        hasCode('DROP_OUTSIDE_SERVICE_AREA'),
      );
    });

    it('allows a pickup-only restricted zone as a drop point', async () => {
      await addZone('SGR_RZ', 'RESTRICTED', OUTER, { pickup: false, drop: true });
      await coverage.assertDropServiceable(drop(IN_ZONE));
    });

    it('refuses a drop in another city', async () => {
      await ensureCityWithBoundary('BLR', 'Bengaluru', box(77.4, 12.8, 77.8, 13.2));
      await assert.rejects(
        () => coverage.assertDropServiceable(drop(OUTSIDE_CITY)),
        hasCode('DROP_OUTSIDE_SERVICE_AREA'),
      );
    });

    it('allows a drop just past the boundary, for suburbs', async () => {
      await coverage.assertDropServiceable(drop({ lat: 34.21, lng: 74.85 }));
    });
  });
});
