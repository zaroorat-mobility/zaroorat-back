import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, describe, it } from 'node:test';

import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { renderMetrics, resetMetrics } from '../../src/core/metrics/index.js';
import { db, resetState } from './helpers/harness.js';
import { NearbyDriverService } from '../../src/modules/geo/services/nearby-driver.service.js';
import type { GeoService } from '../../src/modules/geo/services/geo.service.js';
import type { CoordinateService } from '../../src/modules/geo/services/coordinate.service.js';
import type { GeoMetrics } from '../../src/modules/geo/metrics/geo.metrics.js';
import type { H3Provider } from '../../src/modules/geo/providers/h3.provider.js';
import type { PostgisProvider } from '../../src/modules/geo/providers/postgis.provider.js';
import type { RedisGeoProvider } from '../../src/modules/geo/providers/redis-geo.provider.js';
import type { NearbyDriversResult } from '../../src/modules/geo/types/geo.types.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';

const CENTRE = { latitude: 12.9716, longitude: 77.5946 };

/** Offsets north by roughly `metres`, close enough at this latitude for radius tests. */
function north(metres: number): { latitude: number; longitude: number } {
  return { latitude: CENTRE.latitude + metres / 111_320, longitude: CENTRE.longitude };
}

function geo(): GeoService {
  return container.resolve<GeoService>('geoService');
}
function h3(): H3Provider {
  return container.resolve<H3Provider>('h3Provider');
}
function postgis(): PostgisProvider {
  return container.resolve<PostgisProvider>('postgisProvider');
}
function liveStore(): RedisGeoProvider {
  return container.resolve<RedisGeoProvider>('redisGeoProvider');
}
function locationRepo(): DriverLocationRepository {
  return container.resolve<DriverLocationRepository>('driverLocationRepository');
}

function driverIdsOf(result: NearbyDriversResult): string[] {
  return result.outcome === 'no-live-candidates' ? [] : result.drivers.map((d) => d.driverId);
}

/** A service wired to the real PostGIS but a live store that always throws. */
function serviceWithBrokenLiveStore(): NearbyDriverService {
  const broken = {
    driversInCells: () => Promise.reject(new Error('redis is down')),
  } as unknown as RedisGeoProvider;

  return new NearbyDriverService(
    h3(),
    postgis(),
    broken,
    container.resolve<CoordinateService>('coordinateService'),
    container.resolve<GeoMetrics>('geoMetrics'),
  );
}

/** Records every PostGIS nearby query so a test can assert none was issued. */
function spyOnPostgis(): { calls: unknown[]; restore: () => void } {
  const provider = postgis() as unknown as { findNearbyDrivers: unknown };
  const original = provider.findNearbyDrivers;
  const calls: unknown[] = [];

  provider.findNearbyDrivers = function spy(this: unknown, ...args: unknown[]) {
    calls.push(args[0]);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };

  return {
    calls,
    restore: () => {
      provider.findNearbyDrivers = original;
    },
  };
}

/** A driver row with a durable PostGIS location, without going through HTTP. */
async function seedDriverAt(
  point: { latitude: number; longitude: number },
  recordedAt: Date = new Date(),
): Promise<string> {
  const user = await db().client.user.create({
    data: { phoneNumber: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}` },
  });
  const driver = await db().client.driver.create({
    data: {
      userId: user.id,
      driverCode: `DRV_${randomUUID().slice(0, 8).toUpperCase()}`,
      verificationStatus: 'VERIFIED',
    },
  });

  await locationRepo().updateLocation({ driverId: driver.id, ...point });
  await db().client.$executeRawUnsafe(
    'UPDATE "driver_locations" SET "recorded_at" = $1 WHERE "driver_id" = $2::uuid',
    recordedAt,
    driver.id,
  );

  return driver.id;
}

describe('geo nearby-driver search (integration, real PostGIS + Redis)', () => {
  beforeEach(async () => {
    await resetState();
  });

  describe('spatial index', () => {
    it('has the GiST index the radius query depends on', async () => {
      const rows = await db().client.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'driver_locations'`,
      );
      assert.ok(
        rows.some((row) => /USING gist/i.test(row.indexdef) && /location/.test(row.indexdef)),
        `no GiST index on driver_locations.location — found: ${JSON.stringify(rows)}`,
      );
    });
  });

  describe('PostGIS is the authority', () => {
    it('returns a driver inside the radius', async () => {
      const driverId = await seedDriverAt(north(500));

      const found = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 1000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
      });

      assert.deepEqual(
        found.map((d) => d.driverId),
        [driverId],
      );
    });

    it('excludes a driver outside the radius', async () => {
      await seedDriverAt(north(5000));

      const found = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 1000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
      });

      assert.equal(found.length, 0);
    });

    it('measures distance geodesically, not in JavaScript', async () => {
      await seedDriverAt(north(1000));

      const [found] = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 2000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
      });

      assert.ok(found);
      assert.ok(
        Math.abs(found.distanceMeters - 1000) < 25,
        `expected ~1000m, got ${found.distanceMeters}`,
      );
    });

    it('orders by distance ascending', async () => {
      const far = await seedDriverAt(north(2500));
      const near = await seedDriverAt(north(300));
      const middle = await seedDriverAt(north(1200));

      const found = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 5000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
      });

      assert.deepEqual(
        found.map((d) => d.driverId),
        [near, middle, far],
      );
    });

    it('drops fixes older than the freshness cutoff', async () => {
      await seedDriverAt(north(200), new Date(Date.now() - 10 * 60_000));

      const found = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 1000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
      });

      assert.equal(found.length, 0);
    });

    it('returns nothing for an empty candidate set instead of scanning everything', async () => {
      await seedDriverAt(north(200));

      const found = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 1000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
        driverIds: [],
      });

      assert.equal(found.length, 0);
    });

    it('computes an exact distance between two points', async () => {
      const metres = await postgis().distanceMeters(CENTRE, north(1500));
      assert.ok(Math.abs(metres - 1500) < 30, `expected ~1500m, got ${metres}`);
    });

    it('answers containment with ST_DWithin', async () => {
      assert.equal(await postgis().isWithin(CENTRE, north(900), 1000), true);
      assert.equal(await postgis().isWithin(CENTRE, north(1100), 1000), false);
    });
  });

  describe('Redis live state', () => {
    it('stores a position with its cell and timestamp', async () => {
      const driverId = randomUUID();
      const updatedAt = new Date();

      const written = await liveStore().setPosition({
        driverId,
        ...CENTRE,
        h3Cell: h3().cellFor(CENTRE),
        updatedAt,
      });
      assert.equal(written, true);

      const stored = await liveStore().getPosition(driverId);
      assert.ok(stored);
      assert.equal(stored.driverId, driverId);
      assert.equal(stored.h3Cell, h3().cellFor(CENTRE));
      assert.equal(stored.updatedAt.getTime(), updatedAt.getTime());
    });

    it('indexes the driver under its cell', async () => {
      const driverId = randomUUID();
      const cell = h3().cellFor(CENTRE);
      await liveStore().setPosition({ driverId, ...CENTRE, h3Cell: cell, updatedAt: new Date() });

      assert.deepEqual(await liveStore().driversInCells([cell]), [driverId]);
    });

    it('moves cell membership when the driver crosses into a new cell', async () => {
      const driverId = randomUUID();
      const from = h3().cellFor(CENTRE);
      const distant = { latitude: 28.6139, longitude: 77.209 };
      const to = h3().cellFor(distant);

      await liveStore().setPosition({
        driverId,
        ...CENTRE,
        h3Cell: from,
        updatedAt: new Date(Date.now() - 1000),
      });
      await liveStore().setPosition({
        driverId,
        ...distant,
        h3Cell: to,
        updatedAt: new Date(),
      });

      assert.deepEqual(await liveStore().driversInCells([from]), []);
      assert.deepEqual(await liveStore().driversInCells([to]), [driverId]);
    });

    it('expires the entry so a silent driver ages out', async () => {
      const driverId = randomUUID();
      await liveStore().setPosition({
        driverId,
        ...CENTRE,
        h3Cell: h3().cellFor(CENTRE),
        updatedAt: new Date(),
      });

      const ttl = await redis.ttl(`geo:driver:${driverId}`);
      assert.ok(ttl > 0, `expected a positive TTL, got ${ttl}`);
    });

    it('forgets a position on request', async () => {
      const driverId = randomUUID();
      const cell = h3().cellFor(CENTRE);
      await liveStore().setPosition({ driverId, ...CENTRE, h3Cell: cell, updatedAt: new Date() });

      await liveStore().removePosition(driverId);

      assert.equal(await liveStore().getPosition(driverId), null);
      assert.deepEqual(await liveStore().driversInCells([cell]), []);
    });
  });

  describe('out-of-order location updates', () => {
    it('refuses a fix older than the one already stored', async () => {
      const driverId = randomUUID();
      const newer = new Date();
      const older = new Date(newer.getTime() - 30_000);

      await liveStore().setPosition({
        driverId,
        ...CENTRE,
        h3Cell: h3().cellFor(CENTRE),
        updatedAt: newer,
      });

      const stale = north(2000);
      const written = await liveStore().setPosition({
        driverId,
        ...stale,
        h3Cell: h3().cellFor(stale),
        updatedAt: older,
      });

      assert.equal(written, false, 'a late-arriving older fix must not win');

      const stored = await liveStore().getPosition(driverId);
      assert.equal(stored?.updatedAt.getTime(), newer.getTime());
      assert.equal(stored?.latitude, CENTRE.latitude);
    });

    it('leaves exactly one winner when both fixes are written concurrently', async () => {
      const driverId = randomUUID();
      const newer = new Date();
      const older = new Date(newer.getTime() - 30_000);
      const stale = north(2000);

      await Promise.all([
        liveStore().setPosition({
          driverId,
          ...stale,
          h3Cell: h3().cellFor(stale),
          updatedAt: older,
        }),
        liveStore().setPosition({
          driverId,
          ...CENTRE,
          h3Cell: h3().cellFor(CENTRE),
          updatedAt: newer,
        }),
      ]);

      const stored = await liveStore().getPosition(driverId);
      assert.equal(
        stored?.updatedAt.getTime(),
        newer.getTime(),
        'the newer fix must survive regardless of arrival order',
      );

      // The loser must not leave a dangling membership behind.
      assert.deepEqual(await liveStore().driversInCells([h3().cellFor(stale)]), []);
    });
  });

  describe('GeoService.findNearbyDrivers', () => {
    it('reports ok with the driver present in both the live index and PostGIS', async () => {
      const driverId = await seedDriverAt(north(400));
      await geo().recordDriverPosition({ driverId, ...north(400) });

      const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });

      assert.equal(result.outcome, 'ok');
      assert.deepEqual(driverIdsOf(result), [driverId]);
    });

    it('spans several H3 cells when the radius demands it', async () => {
      const near = await seedDriverAt(north(200));
      const far = await seedDriverAt(north(2500));
      await geo().recordDriverPosition({ driverId: near, ...north(200) });
      await geo().recordDriverPosition({ driverId: far, ...north(2500) });

      assert.notEqual(
        h3().cellFor(north(200)),
        h3().cellFor(north(2500)),
        'test presumes the two points sit in different cells',
      );

      const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 3000 });

      assert.equal(result.outcome, 'ok');
      assert.deepEqual(driverIdsOf(result).sort(), [near, far].sort());
    });

    it('reports ok with an empty list when the live candidate is stale in PostGIS', async () => {
      const driverId = await seedDriverAt(north(300), new Date(Date.now() - 30 * 60_000));
      await geo().recordDriverPosition({ driverId, ...north(300) });

      const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });

      assert.equal(result.outcome, 'ok', 'PostGIS answered — the emptiness is authoritative');
      assert.deepEqual(driverIdsOf(result), []);
    });

    it('excludes a live driver who is outside the radius', async () => {
      const driverId = await seedDriverAt(north(9000));
      await geo().recordDriverPosition({ driverId, ...north(9000) });

      const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });

      assert.deepEqual(driverIdsOf(result), []);
    });

    it('honours the candidate limit', async () => {
      for (let i = 0; i < 4; i += 1) {
        const driverId = await seedDriverAt(north(100 + i * 50));
        await geo().recordDriverPosition({ driverId, ...north(100 + i * 50) });
      }

      const result = await geo().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 2000,
        limit: 2,
      });

      assert.equal(driverIdsOf(result).length, 2);
    });

    it('rejects an invalid origin rather than querying', async () => {
      await assert.rejects(
        () => geo().findNearbyDrivers({ origin: { latitude: 91, longitude: 77 } }),
        /GEO_INVALID_COORDINATE|not a valid coordinate/,
      );
    });

    it('refuses a radius beyond the configured ceiling', async () => {
      await assert.rejects(
        () => geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 10_000_000 }),
        /GEO_RADIUS_TOO_LARGE|exceeds the maximum/,
      );
    });
  });

  describe('live-store loss is distinguishable from an empty road', () => {
    it('reports no-live-candidates when the index is reachable and empty', async () => {
      const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 2000 });

      assert.equal(result.outcome, 'no-live-candidates');
      assert.equal('drivers' in result, false, 'the caller must not be handed a misleading []');
    });

    it('does not query PostGIS at all when the live index is empty', async () => {
      await seedDriverAt(north(300));
      const spy = spyOnPostgis();

      try {
        const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 2000 });
        assert.equal(result.outcome, 'no-live-candidates');
        assert.equal(spy.calls.length, 0, 'cache emptiness must not become a database scan');
      } finally {
        spy.restore();
      }
    });

    it('reports no-live-candidates after a flush, never "no drivers exist"', async () => {
      const driverId = await seedDriverAt(north(400));
      await geo().recordDriverPosition({ driverId, ...north(400) });
      await redis.flushdb();

      const result = await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });

      assert.equal(result.outcome, 'no-live-candidates');

      const direct = await postgis().findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: 1000,
        freshAfter: new Date(Date.now() - 60_000),
        limit: 10,
      });
      assert.deepEqual(
        direct.map((d) => d.driverId),
        [driverId],
        'the durable record survives the flush untouched',
      );
    });

    it('falls back to PostGIS and reports degraded when the live store errors', async () => {
      const driverId = await seedDriverAt(north(400));

      const result = await serviceWithBrokenLiveStore().find({
        origin: CENTRE,
        radiusMeters: 1000,
      });

      assert.equal(result.outcome, 'degraded');
      assert.deepEqual(driverIdsOf(result), [driverId]);
    });

    it('bounds the fallback by the requested radius — it is not a full table scan', async () => {
      const inside = await seedDriverAt(north(400));
      await seedDriverAt(north(9000));
      await seedDriverAt(north(14000));

      const result = await serviceWithBrokenLiveStore().find({
        origin: CENTRE,
        radiusMeters: 1000,
      });

      assert.equal(result.outcome, 'degraded');
      assert.deepEqual(
        driverIdsOf(result),
        [inside],
        'the fallback stays bounded by ST_DWithin on the requested radius',
      );
    });

    it('makes a live-store failure observable in the metrics', async () => {
      await seedDriverAt(north(400));
      resetMetrics();

      await serviceWithBrokenLiveStore().find({ origin: CENTRE, radiusMeters: 1000 });

      const rendered = renderMetrics();
      assert.match(rendered, /geo\.redis_errors_total/);
      assert.match(rendered, /geo\.postgis_fallback_total/);
    });

    it('counts an empty live index separately from a fallback', async () => {
      resetMetrics();

      await geo().findNearbyDrivers({ origin: CENTRE, radiusMeters: 2000 });

      const rendered = renderMetrics();
      assert.match(rendered, /geo\.no_live_candidates_total/);
      assert.equal(
        /geo\.postgis_fallback_total/.test(rendered),
        false,
        'an empty index is not a fallback',
      );
    });

    it('leaves PostGIS uncorrupted after a live-store failure', async () => {
      const driverId = await seedDriverAt(north(400));
      const before = await db().client.driverLocation.findUniqueOrThrow({ where: { driverId } });

      await serviceWithBrokenLiveStore().find({ origin: CENTRE, radiusMeters: 1000 });

      const after = await db().client.driverLocation.findUniqueOrThrow({ where: { driverId } });
      assert.deepEqual(after, before, 'a Geo read must never mutate the durable row');
    });
  });

  describe('driver location ingestion keeps PostGIS and the live index in step', () => {
    it('mirrors a durable write into the live index', async () => {
      const driverId = await seedDriverAt(north(600));

      const stored = await container
        .resolve<GeoService>('geoService')
        .recordDriverPosition({ driverId, ...north(600) });

      const live = await geo().liveDriverPosition(driverId);
      assert.equal(live?.h3Cell, stored.h3Cell);
      assert.equal(live?.driverId, driverId);
    });

    it('does not let the live mirror alter the durable row', async () => {
      const driverId = await seedDriverAt(north(400));
      const before = await db().client.driverLocation.findUniqueOrThrow({ where: { driverId } });

      await geo().recordDriverPosition({ driverId, ...north(400) });

      const after = await db().client.driverLocation.findUniqueOrThrow({ where: { driverId } });
      assert.deepEqual(after, before);
    });
  });
});

before(() => {
  assert.ok(
    container.hasRegistration('geoService'),
    'geo module must be registered in the container',
  );
});
