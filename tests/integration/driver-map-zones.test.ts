import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import {
  bootApp,
  db,
  drainOutbox,
  loginAs,
  resetState,
  type LoggedInUser,
} from './helpers/harness.js';
import {
  ensureCity,
  ensureCityWithBoundary,
  ensureServiceZone,
  grantRole,
  makeAssignedVehicle,
  makeDriver,
  makeRideRequest,
  makeVehicleType,
  markDriverOnline,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';
import type { DriverMapZonesRepository } from '../../src/modules/drivers/services/map-zones/map-zones.repository.js';

type Ring = number[][];
const square = (w: number, s: number, e: number, n: number): Ring[] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ],
];

const CITY = square(77.4, 12.8, 77.8, 13.2);
const SERVICE = square(77.55, 12.93, 77.65, 13.01);
const RESTRICTED = square(77.595, 12.955, 77.605, 12.965);
const AIRPORT = square(77.66, 13.0, 77.69, 13.03);
const INACTIVE = square(77.51, 12.91, 77.52, 12.92);
const DELHI = square(77.2, 28.6, 77.21, 28.61);
const LEGACY_SURGE = square(77.56, 12.98, 77.58, 13.0);
/// Self-intersecting: the geography column accepts it, ST_IsValid does not.
const BOWTIE: Ring[] = [
  [
    [77.52, 12.92],
    [77.54, 12.94],
    [77.54, 12.92],
    [77.52, 12.94],
    [77.52, 12.92],
  ],
];
const VIEWPORT = 'minLat=12.90&minLng=77.50&maxLat=13.05&maxLng=77.70';
const HOUR = 3_600_000;

type Zone = {
  id: string;
  type: string;
  name: string | null;
  geometry: { type: string; coordinates: number[][][] };
  severity: string | null;
  vehicleTypes: Array<{ id: string; code: string }> | null;
  eligibleForYourVehicle: boolean | null;
  validFrom: string | null;
  validTo: string | null;
  updatedAt: string;
  details: Record<string, Record<string, unknown>>;
};
type Layers = Record<
  'demand' | 'surge' | 'restricted' | 'service' | 'incentives' | 'hotspots',
  { status: string; zones: Zone[] }
>;

/// HH:mm in IST, `offsetMinutes` from now — for a peak window that is certainly not now.
function istClock(offsetMinutes: number): string {
  const ist = new Date(Date.now() + offsetMinutes * 60_000 + 330 * 60_000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
}

async function insertZone(
  cityId: string,
  code: string,
  zoneType: 'SERVICE' | 'AIRPORT' | 'RESTRICTED',
  coordinates: Ring[],
  opts: { allowsPickup?: boolean; allowsDropoff?: boolean; isActive?: boolean } = {},
): Promise<string> {
  const geoJson = JSON.stringify({ type: 'Polygon', coordinates });
  const rows = await db().client.$queryRaw<Array<{ id: string }>>`
    INSERT INTO service_zones (id, city_id, code, name, zone_type, boundary, allows_pickup,
                               allows_dropoff, is_active, created_at, updated_at)
    VALUES (gen_random_uuid(), ${cityId}::uuid, ${code}, ${code}, ${zoneType}::"ServiceZoneType",
            ST_GeomFromGeoJSON(${geoJson}), ${opts.allowsPickup ?? true}, ${opts.allowsDropoff ?? true},
            ${opts.isActive ?? true}, NOW(), NOW())
    RETURNING id`;
  return rows[0]!.id;
}

describe('driver operations map zones (integration, real PostGIS)', () => {
  let app: FastifyInstance;
  let driver: LoggedInUser & { driverId: string };
  let myType: string;
  let otherType: string;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
    const seed = await loginAs(app, '+919876780001');
    await grantRole(seed.userId, 'driver');
    await drainOutbox();
    const user = await loginAs(app, '+919876780001');
    const driverId = await makeDriver(user.userId, { verified: true });
    myType = await makeVehicleType({ code: 'MAPMINI' });
    otherType = await makeVehicleType({ code: 'MAPAUTO' });
    await makeAssignedVehicle(driverId, { vehicleTypeId: myType });
    driver = { ...user, driverId };
  });

  function getZones(user: LoggedInUser | null, query = VIEWPORT) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/drivers/me/map-zones?${query}`,
      ...(user ? { headers: user.authHeader } : {}),
    });
  }

  async function layers(query = VIEWPORT): Promise<Layers> {
    const res = await getZones(driver, query);
    assert.equal(res.statusCode, 200, res.payload);
    return res.json().data.layers as Layers;
  }

  describe('access', () => {
    it('refuses an unauthenticated caller', async () => {
      assert.equal((await getZones(null)).statusCode, 401);
    });

    it('refuses a rider — this is a driver operations map', async () => {
      const rider = await loginAs(app, '+919876780002');
      assert.equal((await getZones(rider)).statusCode, 403);
    });

    it('refuses an oversized, inverted or unknown-layer query', async () => {
      for (const query of [
        'minLat=12&minLng=77&maxLat=14&maxLng=78',
        'minLat=13.05&minLng=77.50&maxLat=12.90&maxLng=77.70',
        `${VIEWPORT}&layers=incentives`,
        'minLat=north&minLng=77.50&maxLat=13.05&maxLng=77.70',
      ]) {
        const res = await getZones(driver, query);
        assert.equal(res.statusCode, 400, `${query}: ${res.payload}`);
      }
    });

    it('rate-limits a client that loops (60 requests a minute per driver)', async () => {
      const cheap = `${VIEWPORT}&layers=restricted`;
      for (let i = 0; i < 60; i++) {
        const res = await getZones(driver, cheap);
        assert.equal(res.statusCode, 200, `request ${i + 1}: ${res.payload}`);
      }
      assert.equal((await getZones(driver, cheap)).statusCode, 429);
    });
  });

  describe('backend-managed zones', () => {
    let restrictedId: string;
    let airportId: string;

    beforeEach(async () => {
      const cityId = await ensureCityWithBoundary('BLR', 'Bengaluru', CITY);
      await ensureServiceZone('BLR', 'BLR_CORE', 'Central', SERVICE);
      restrictedId = await insertZone(cityId, 'BLR_CANTONMENT', 'RESTRICTED', RESTRICTED, {
        allowsPickup: false,
        allowsDropoff: true,
      });
      airportId = await insertZone(cityId, 'BLR_AIRPORT', 'AIRPORT', AIRPORT);
      await db().client.serviceZoneVehicleType.create({
        data: { serviceZoneId: airportId, vehicleTypeId: otherType },
      });
      await insertZone(cityId, 'BLR_OLD', 'SERVICE', INACTIVE, { isActive: false });
      await insertZone(cityId, 'BLR_BROKEN', 'SERVICE', BOWTIE);
      await insertZone(cityId, 'BLR_FAR', 'SERVICE', DELHI);
      // A zone under a city pricing and enforcement never resolve (no boundary)
      // must not be drawn either: it would look like coverage that does not apply.
      const unbounded = await ensureCity('MYS', 'Mysuru');
      await insertZone(unbounded, 'MYS_STRAY', 'RESTRICTED', square(77.6, 12.94, 77.61, 12.95));
    });

    it('returns restricted zones with their real access rules and geometry', async () => {
      const { restricted } = await layers();
      assert.equal(restricted.status, 'ok');
      assert.equal(restricted.zones.length, 1);
      const zone = restricted.zones[0]!;
      assert.equal(zone.id, `RESTRICTED:${restrictedId}`);
      assert.equal(zone.type, 'RESTRICTED');
      assert.deepEqual(zone.details.access, { allowsPickup: false, allowsDropoff: true });
      assert.equal(zone.severity, 'MEDIUM', 'drop-off still allowed');
      assert.equal(zone.vehicleTypes, null, 'a restriction applies to every vehicle');
      assert.deepEqual(zone.geometry, { type: 'Polygon', coordinates: RESTRICTED });
      assert.ok(!Number.isNaN(Date.parse(zone.updatedAt)));
    });

    it('marks an airport that admits only another vehicle type as not for you', async () => {
      const { service } = await layers();
      const types = service.zones.map((z) => z.type).sort();
      assert.deepEqual(
        types,
        ['AIRPORT', 'SERVICE_AREA'],
        'inactive, invalid and far zones left out',
      );
      const airport = service.zones.find((z) => z.type === 'AIRPORT')!;
      assert.equal(airport.id, `AIRPORT:${airportId}`);
      assert.deepEqual(
        airport.vehicleTypes?.map((v) => v.code),
        ['MAPAUTO'],
      );
      assert.equal(airport.eligibleForYourVehicle, false);
      const core = service.zones.find((z) => z.type === 'SERVICE_AREA')!;
      assert.equal(core.vehicleTypes, null);
      assert.equal(core.eligibleForYourVehicle, true);
    });

    it('computes only the layers asked for', async () => {
      const result = await layers(`${VIEWPORT}&layers=restricted`);
      assert.equal(result.restricted.status, 'ok');
      for (const name of ['demand', 'surge', 'service'] as const) {
        assert.deepEqual(result[name], { status: 'skipped', zones: [] }, name);
      }
    });

    it('reports incentives and pickup hotspots as unsupported — never invented', async () => {
      const result = await layers();
      assert.deepEqual(result.incentives, { status: 'unsupported', zones: [] });
      assert.deepEqual(result.hotspots, { status: 'unsupported', zones: [] });
    });
  });

  describe('surge', () => {
    let coreId: string;

    beforeEach(async () => {
      await ensureCityWithBoundary('BLR', 'Bengaluru', CITY);
      coreId = await ensureServiceZone('BLR', 'BLR_CORE', 'Central', SERVICE);
    });

    async function surgeWindow(data: Record<string, unknown>) {
      await db().client.surgeWindow.create({
        data: {
          serviceZoneId: coreId,
          multiplier: 1.5,
          startsAt: new Date(Date.now() - HOUR),
          ...data,
        } as never,
      });
    }

    it('shows the multiplier your vehicle would get, from active pricing windows', async () => {
      const endsAt = new Date(Date.now() + HOUR);
      await surgeWindow({ multiplier: 1.3 });
      await surgeWindow({ multiplier: 1.7, vehicleTypeId: myType, endsAt });
      await surgeWindow({ multiplier: 1.9, endsAt: new Date(Date.now() - 1000) });
      await surgeWindow({
        multiplier: 1.95,
        isPeakHourOnly: true,
        peakHourStart: istClock(120),
        peakHourEnd: istClock(180),
      });

      const { surge } = await layers();
      assert.equal(surge.status, 'ok');
      assert.equal(surge.zones.length, 1);
      const zone = surge.zones[0]!;
      assert.equal(zone.id, `SURGE:${coreId}`);
      assert.deepEqual(zone.details.surge, {
        multiplier: 1.7,
        maxMultiplier: 1.7,
        peakHours: null,
      });
      assert.equal(zone.severity, 'MEDIUM');
      assert.equal(zone.eligibleForYourVehicle, true);
      assert.equal(zone.vehicleTypes, null, 'the 1.3x window applies to every type');
      assert.equal(zone.validTo, endsAt.toISOString());
    });

    it("shows another vehicle type's surge as not applying to you", async () => {
      await surgeWindow({ multiplier: 1.8, vehicleTypeId: otherType });
      const zone = (await layers()).surge.zones[0]!;
      assert.equal(zone.details.surge?.multiplier, null);
      assert.equal(zone.details.surge?.maxMultiplier, 1.8);
      assert.equal(zone.eligibleForYourVehicle, false);
      assert.deepEqual(
        zone.vehicleTypes?.map((v) => v.code),
        ['MAPAUTO'],
      );
    });

    it('still resolves windows that only carry the legacy surge-zone link', async () => {
      const geoJson = JSON.stringify({ type: 'Polygon', coordinates: LEGACY_SURGE });
      const [legacy] = await db().client.$queryRaw<Array<{ id: string }>>`
        INSERT INTO surge_zones (id, city_code, name, boundary, is_active, created_at)
        VALUES (gen_random_uuid(), 'BLR', 'Legacy MG Road', ST_GeomFromGeoJSON(${geoJson}), true, NOW())
        RETURNING id`;
      await db().client.surgeWindow.create({
        data: { zoneId: legacy!.id, multiplier: 1.4, startsAt: new Date(Date.now() - HOUR) },
      });
      const zone = (await layers()).surge.zones.find((z) => z.id === `SURGE:${legacy!.id}`);
      assert.ok(zone, 'legacy window shown');
      assert.equal(zone.name, 'Legacy MG Road');
      assert.equal(zone.details.surge?.multiplier, 1.4);
    });

    it('shows nothing when no window is in force', async () => {
      await surgeWindow({ multiplier: 1.6, startsAt: new Date(Date.now() + HOUR) });
      assert.deepEqual((await layers()).surge, { status: 'ok', zones: [] });
    });
  });

  describe('demand', () => {
    let riders = 0;
    /// One open request per rider is a schema rule (ride_requests_active_customer_key),
    /// so each request comes from its own rider — as real demand does.
    async function requestFromNewRider(): Promise<string> {
      riders += 1;
      const rider = await db().client.user.create({
        data: { phoneNumber: `+91987679${String(riders).padStart(4, '0')}` },
      });
      return makeRideRequest(rider.id, myType);
    }

    beforeEach(async () => {
      // Our driver is the one free driver at the pickup point.
      await markDriverOnline(driver.driverId);
      await container
        .resolve<DriverLocationRepository>('driverLocationRepository')
        .updateLocation({ driverId: driver.driverId, latitude: 12.972, longitude: 77.5947 });
    });

    it('turns real recent requests into a demand cell, graded against free drivers', async () => {
      for (let i = 0; i < 3; i++) await requestFromNewRider();
      const { demand } = await layers();
      assert.equal(demand.status, 'ok');
      assert.equal(demand.zones.length, 1);
      const zone = demand.zones[0]!;
      assert.equal(zone.type, 'DEMAND');
      assert.deepEqual(zone.details.demand, {
        requests: 3,
        availableDrivers: 1,
        windowMinutes: 15,
      });
      assert.equal(zone.severity, 'HIGH');
      const ring = zone.geometry.coordinates[0]!;
      assert.deepEqual(ring[0], ring[ring.length - 1], 'closed hexagon');
    });

    it('never shows one rider who re-requested, however many times', async () => {
      const rider = await db().client.user.create({ data: { phoneNumber: '+919876791111' } });
      for (let i = 0; i < 3; i++) {
        // One open request per rider: each earlier attempt has expired, as in real retries.
        const id = await makeRideRequest(rider.id, myType);
        await db().client.$executeRaw`
          UPDATE ride_requests SET status = 'EXPIRED' WHERE id = ${id}::uuid`;
      }
      await requestFromNewRider();
      assert.deepEqual(
        (await layers()).demand,
        { status: 'ok', zones: [] },
        '2 riders, 4 requests',
      );
      await requestFromNewRider();
      const [zone] = (await layers()).demand.zones;
      assert.equal(zone?.details.demand?.requests, 5, 'shown once 3 different riders asked');
    });

    it('never shows fewer than three requests, or requests older than the window', async () => {
      await requestFromNewRider();
      await requestFromNewRider();
      const old = await requestFromNewRider();
      await db().client.$executeRaw`
        UPDATE ride_requests SET created_at = NOW() - INTERVAL '1 hour' WHERE id = ${old}::uuid`;
      assert.deepEqual((await layers()).demand, { status: 'ok', zones: [] });
    });

    it('keeps the other layers when one fails, and says which one failed', async () => {
      const repo = container.resolve<DriverMapZonesRepository>('driverMapZonesRepository');
      const original = repo.findRecentRequestPoints;
      repo.findRecentRequestPoints = async () => {
        throw new Error('simulated outage');
      };
      try {
        const result = await layers();
        assert.deepEqual(result.demand, { status: 'error', zones: [] });
        assert.equal(result.surge.status, 'ok');
        assert.equal(result.restricted.status, 'ok');
      } finally {
        repo.findRecentRequestPoints = original;
      }
    });
  });
});
