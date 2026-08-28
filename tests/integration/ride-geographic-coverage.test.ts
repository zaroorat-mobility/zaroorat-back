import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { container } from '../../src/core/di.js';
import { GeographicCoverageService } from '../../src/modules/geographic/index.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { ensureCity, ensureServiceZone } from './helpers/fixtures.js';

const SGR_BOUNDARY: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

const RESTRICTED: number[][][] = [
  [
    [74.72, 34.05],
    [74.74, 34.05],
    [74.74, 34.07],
    [74.72, 34.07],
    [74.72, 34.05],
  ],
];

describe('ride geographic coverage (integration)', () => {
  let app: FastifyInstance;
  let coverage: GeographicCoverageService;

  before(async () => {
    app = await bootApp();
    coverage = container.resolve<GeographicCoverageService>('geographicCoverageService');
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    const cab = await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY' } });
    await ensureCity('SGR', 'Srinagar');
    const boundaryJson = JSON.stringify({ type: 'Polygon', coordinates: SGR_BOUNDARY });
    await db().client.$executeRaw`
      UPDATE cities SET boundary = ST_GeomFromGeoJSON(${boundaryJson}) WHERE code = 'SGR'
    `;
    await ensureServiceZone('SGR', 'SGR_CITYWIDE', 'Citywide', SGR_BOUNDARY);
    await db().client.$executeRaw`
      INSERT INTO service_zones (id, city_id, code, name, zone_type, boundary, allows_pickup, allows_dropoff, is_active, created_at, updated_at)
      SELECT gen_random_uuid(), c.id, 'SGR_RESTRICTED', 'Restricted', 'RESTRICTED'::"ServiceZoneType",
        ST_GeomFromGeoJSON(${JSON.stringify({ type: 'Polygon', coordinates: RESTRICTED })}),
        false, false, true, NOW(), NOW()
      FROM cities c WHERE c.code = 'SGR'
      ON CONFLICT DO NOTHING
    `;
    void cab;
  });
  afterEach(async () => {
    await resetState();
  });

  it('resolves city at pickup inside boundary', async () => {
    const city = await coverage.resolveCityAtPoint(34.1, 74.85);
    assert.ok(city);
    assert.equal(city!.code, 'SGR');
  });

  it('blocks pickup inside restricted zone', async () => {
    const cab = await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY' } });
    await assert.rejects(
      () =>
        coverage.assertPickupServiceable({
          lat: 34.06,
          lng: 74.73,
          vehicleTypeId: cab.id,
        }),
      /restricted/i,
    );
  });
});
