import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { createPricingRuleDirect, ensureCity, ensureServiceZone } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { PricingRuleRepository } from '../../src/modules/pricing/repositories/pricing-rule.repository.js';

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

/** Inside SGR airport polygon */
const AIRPORT_LAT = 34.015;
const AIRPORT_LNG = 74.775;

/** Inside citywide SGR but outside airport */
const CITY_LAT = 34.1;
const CITY_LNG = 74.85;

describe('pricing rule resolution (integration)', () => {
  let app: FastifyInstance;
  let repo: PricingRuleRepository;
  let vehicleTypeId: string;

  before(async () => {
    app = await bootApp();
    repo = container.resolve<PricingRuleRepository>('pricingRuleRepository');
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    const cab = await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY' } });
    vehicleTypeId = cab.id;
    await ensureCity('SGR', 'Srinagar');
    await ensureServiceZone('SGR', 'SGR_CITYWIDE', 'Srinagar Citywide', SGR_CITYWIDE_POLYGON);
  });
  afterEach(async () => {
    await resetState();
  });

  it('prefers zone-specific rule over citywide rule at pickup inside the zone', async () => {
    const airportZoneId = await ensureServiceZone(
      'SGR',
      'SGR_AIRPORT',
      'SGR Airport',
      SGR_AIRPORT_POLYGON,
    );

    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 50,
      serviceType: 'INSTANT',
      serviceZoneId: null,
    });
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 120,
      serviceType: 'INSTANT',
      serviceZoneId: airportZoneId,
    });

    const atAirport = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      serviceType: 'INSTANT',
      pickupLat: AIRPORT_LAT,
      pickupLng: AIRPORT_LNG,
    });
    assert.ok(atAirport);
    assert.equal(Number(atAirport!.baseFare), 120);

    const inCity = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      serviceType: 'INSTANT',
      pickupLat: CITY_LAT,
      pickupLng: CITY_LNG,
    });
    assert.ok(inCity);
    assert.equal(Number(inCity!.baseFare), 50);
  });

  it('prefers exact service type over wildcard and falls back to GLOBAL', async () => {
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 40,
      serviceType: null,
    });
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 70,
      serviceType: 'SCHEDULED',
    });
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'GLOBAL',
      baseFare: 30,
      serviceType: null,
    });

    const scheduled = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      serviceType: 'SCHEDULED',
      pickupLat: CITY_LAT,
      pickupLng: CITY_LNG,
    });
    assert.ok(scheduled);
    assert.equal(Number(scheduled!.baseFare), 70);

    const instant = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      serviceType: 'INSTANT',
      pickupLat: CITY_LAT,
      pickupLng: CITY_LNG,
    });
    assert.ok(instant);
    assert.equal(Number(instant!.baseFare), 40);

    const unknownCity = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'BLR',
      serviceType: 'INSTANT',
      pickupLat: 12.97,
      pickupLng: 77.59,
    });
    assert.ok(unknownCity);
    assert.equal(Number(unknownCity!.baseFare), 30);
  });
});
