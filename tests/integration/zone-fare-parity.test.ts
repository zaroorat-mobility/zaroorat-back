import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { randomUUID } from 'node:crypto';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  completeProfile,
  createPricingRuleDirect,
  ensureCity,
  ensureCityWithBoundary,
  ensureServiceZone,
  setZonePriority,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { PricingRuleRepository } from '../../src/modules/pricing/repositories/pricing-rule.repository.js';
import { PricingService } from '../../src/modules/pricing/services/pricing.service.js';
import { GeographicCoverageService } from '../../src/modules/geographic/index.js';

/// Srinagar, wide enough to contain the airport polygon below.
const CITY_POLYGON: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

/// Nested inside CITY_POLYGON. The whole point of the suite is that a point in
/// here resolves to *this* zone and not to the one that contains it.
const AIRPORT_POLYGON: number[][][] = [
  [
    [74.76, 34.0],
    [74.79, 34.0],
    [74.79, 34.03],
    [74.76, 34.03],
    [74.76, 34.0],
  ],
];

const AIRPORT = { lat: 34.015, lng: 74.775 };
const IN_CITY = { lat: 34.1, lng: 74.85 };
const FAR_AWAY = { lat: 19.076, lng: 72.8777 };

const DAY = 24 * 60 * 60 * 1000;

/// FR-001 / FR-002 / FR-003 / FR-004 / FR-005 / FR-041 / FR-048.
///
/// The invariant the whole of Phase 1 exists to establish:
///
///     quote rate card === booked rate card === final bill rate card
///
/// Before Phase 1 it held only by accident. `calculateFinalFare` was called with
/// no city and no coordinates, so it resolved the GLOBAL default card while the
/// quote had used a city- or zone-scoped rule, and the customer was billed on a
/// rate card they were never shown.
describe('zone fare parity: quote === booked === billed (integration)', () => {
  let app: FastifyInstance;
  let repo: PricingRuleRepository;
  let pricing: PricingService;
  let coverage: GeographicCoverageService;
  let vehicleTypeId: string;

  before(async () => {
    app = await bootApp();
    repo = container.resolve<PricingRuleRepository>('pricingRuleRepository');
    pricing = container.resolve<PricingService>('pricingService');
    coverage = container.resolve<GeographicCoverageService>('geographicCoverageService');
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    const cab = await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY' } });
    vehicleTypeId = cab.id;
  });
  afterEach(async () => {
    await resetState();
  });

  async function seedNestedZones(): Promise<{ airportZoneId: string; cityZoneId: string }> {
    await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
    const cityZoneId = await ensureServiceZone('SGR', 'SGR_CITY', 'Srinagar City', CITY_POLYGON);
    const airportZoneId = await ensureServiceZone(
      'SGR',
      'SGR_AIRPORT',
      'SGR Airport',
      AIRPORT_POLYGON,
    );
    return { airportZoneId, cityZoneId };
  }

  /// The load-bearing assertion. `rateCardForRuleId` is the exact call the
  /// completion path makes, so proving it returns the quote's card proves the
  /// bill and the quote agree.
  async function assertBillMatchesQuote(
    ruleId: string | null,
    cityCode: string,
    at: typeof AIRPORT,
  ) {
    const quoteCard = (
      await pricing.resolveRateCard(vehicleTypeId, cityCode, {
        pickupLat: at.lat,
        pickupLng: at.lng,
      })
    ).card;
    const billCard = await pricing.rateCardForRuleId(ruleId, { vehicleTypeId, cityCode: 'GLOBAL' });
    assert.deepEqual(
      billCard,
      quoteCard,
      'the bill must be computed on the card the quote was priced with',
    );
    return quoteCard;
  }

  it('bills a zone-scoped ride on the zone rule, not the GLOBAL card (FR-001, FR-002)', async () => {
    const { airportZoneId } = await seedNestedZones();
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 30 });
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 50 });
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 120,
      serviceZoneId: airportZoneId,
    });

    const { card, ruleId } = await pricing.resolveRateCard(vehicleTypeId, 'SGR', {
      pickupLat: AIRPORT.lat,
      pickupLng: AIRPORT.lng,
    });
    assert.equal(card.baseFare, 120, 'the quote must use the airport zone rule');
    assert.ok(ruleId, 'the resolved rule must be identifiable so booking can record it');

    // This is what completion now does: re-read the booked rule rather than
    // resolving a fresh card from a context it does not have.
    const billed = await assertBillMatchesQuote(ruleId, 'SGR', AIRPORT);
    assert.equal(billed.baseFare, 120);
  });

  it('bills a city-scoped ride on the city rule (FR-001)', async () => {
    await seedNestedZones();
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 30 });
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 50 });

    const { card, ruleId } = await pricing.resolveRateCard(vehicleTypeId, 'SGR', {
      pickupLat: IN_CITY.lat,
      pickupLng: IN_CITY.lng,
    });
    assert.equal(card.baseFare, 50);
    const billed = await assertBillMatchesQuote(ruleId, 'SGR', IN_CITY);
    assert.equal(billed.baseFare, 50);
  });

  it('falls back to the GLOBAL rule when the city has none of its own', async () => {
    await seedNestedZones();
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 30 });

    const { card, ruleId } = await pricing.resolveRateCard(vehicleTypeId, 'SGR', {
      pickupLat: IN_CITY.lat,
      pickupLng: IN_CITY.lng,
    });
    assert.equal(card.baseFare, 30);
    const billed = await assertBillMatchesQuote(ruleId, 'SGR', IN_CITY);
    assert.equal(billed.baseFare, 30);
  });

  it('ignores a rule dated into the future (FR-003)', async () => {
    await seedNestedZones();
    const currentRuleId = await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 50,
    });
    // A properly staged rate change: the incumbent's window is closed on the day
    // the successor opens. FR-034's exclusion constraint requires this — two live
    // rules on one key may not cover overlapping periods — and it is what an
    // operator scheduling a price rise actually means.
    const changeover = new Date(Date.now() + 30 * DAY);
    await db().client.pricingRule.update({
      where: { id: currentRuleId },
      data: { effectiveTo: changeover },
    });
    // Ordered by `effectiveFrom desc`, this row sorts ahead of every current one,
    // which is precisely how a scheduled rate change used to enact itself early.
    await db().client.pricingRule.create({
      data: {
        vehicleTypeId,
        cityCode: 'SGR',
        baseFare: 999,
        minimumFare: 999,
        perKmRate: 0,
        perMinuteRate: 0,
        effectiveFrom: changeover,
      },
    });

    const rule = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      pickupLat: IN_CITY.lat,
      pickupLng: IN_CITY.lng,
    });
    assert.equal(Number(rule?.baseFare), 50, 'a scheduled rate card must wait for its start date');
  });

  it('ignores a rule whose window has closed (FR-003)', async () => {
    await seedNestedZones();
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 30 });
    await db().client.pricingRule.create({
      data: {
        vehicleTypeId,
        cityCode: 'SGR',
        baseFare: 777,
        minimumFare: 777,
        perKmRate: 0,
        perMinuteRate: 0,
        effectiveFrom: new Date(Date.now() - 30 * DAY),
        effectiveTo: new Date(Date.now() - DAY),
      },
    });

    const rule = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      pickupLat: IN_CITY.lat,
      pickupLng: IN_CITY.lng,
    });
    assert.equal(Number(rule?.baseFare), 30, 'a retired rate card must stop pricing rides');
  });

  it('never resolves a RESTRICTED zone for pricing (FR-004)', async () => {
    await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
    const restrictedId = await ensureServiceZone(
      'SGR',
      'SGR_RESTRICTED',
      'Restricted',
      AIRPORT_POLYGON,
    );
    await db().client.serviceZone.update({
      where: { id: restrictedId },
      data: { zoneType: 'RESTRICTED' },
    });
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 50 });
    // A rule hung off the restricted zone. Pricing must not reach it: the old
    // resolver took the oldest zone of any type and could bind a fare to a zone
    // the coverage check had already refused for pickup.
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 400,
      serviceZoneId: restrictedId,
    });

    const zoneId = await coverage.resolveServiceZoneIdAtPoint('SGR', AIRPORT.lat, AIRPORT.lng);
    assert.equal(zoneId, null, 'a RESTRICTED zone is not a pricing zone');

    const rule = await repo.findBestActiveRule({
      vehicleTypeId,
      cityCode: 'SGR',
      pickupLat: AIRPORT.lat,
      pickupLng: AIRPORT.lng,
    });
    assert.equal(Number(rule?.baseFare), 50, 'the restricted zone rule must be unreachable');
  });

  it('prefers the smallest containing zone, then an explicit priority (FR-005)', async () => {
    const { airportZoneId, cityZoneId } = await seedNestedZones();
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 50,
      serviceZoneId: cityZoneId,
    });
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 120,
      serviceZoneId: airportZoneId,
    });

    // Default: no priority set anywhere, so the nested polygon wins on area.
    assert.equal(
      await coverage.resolveServiceZoneIdAtPoint('SGR', AIRPORT.lat, AIRPORT.lng),
      airportZoneId,
      'the specific zone must win without anyone configuring a priority',
    );

    // Override: an operator can still force the outer zone to take precedence.
    await setZonePriority(cityZoneId, 10);
    assert.equal(
      await coverage.resolveServiceZoneIdAtPoint('SGR', AIRPORT.lat, AIRPORT.lng),
      cityZoneId,
      'an explicit priority must beat the area default',
    );
  });

  it('an admin edit after booking does not move an in-progress ride (FR-002)', async () => {
    const { airportZoneId } = await seedNestedZones();
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 30 });
    const bookedRuleId = await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 120,
      serviceZoneId: airportZoneId,
    });

    const { ruleId } = await pricing.resolveRateCard(vehicleTypeId, 'SGR', {
      pickupLat: AIRPORT.lat,
      pickupLng: AIRPORT.lng,
    });
    assert.equal(ruleId, bookedRuleId);

    // What `AdminFareService` does on edit: retire the row and insert a new
    // version. The ride in flight must keep the terms it was booked on.
    await db().client.pricingRule.update({
      where: { id: bookedRuleId },
      data: { isActive: false },
    });
    await createPricingRuleDirect({
      vehicleTypeId,
      cityCode: 'SGR',
      baseFare: 999,
      serviceZoneId: airportZoneId,
    });

    const billed = await pricing.rateCardForRuleId(ruleId, {
      vehicleTypeId,
      cityCode: 'GLOBAL',
    });
    assert.equal(billed.baseFare, 120, 'the booked rule prices the ride, not the edited one');
  });

  it('falls back to live resolution when the request predates the column (FR-002)', async () => {
    await seedNestedZones();
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 50 });

    // A row written by the previous application version carries no rule id.
    // Migrate-then-deploy guarantees such rows exist during a rollout, so this
    // path must price rather than throw.
    const card = await pricing.rateCardForRuleId(null, {
      vehicleTypeId,
      cityCode: 'SGR',
      options: { pickupLat: IN_CITY.lat, pickupLng: IN_CITY.lng },
    });
    assert.equal(card.baseFare, 50);
  });

  describe('coverage gate (FR-048, BD-10)', () => {
    it('serves a pickup on GLOBAL pricing when no coverage is configured', async () => {
      // No city has a boundary — the state every environment is in today.
      await ensureCity('SGR', 'Srinagar');
      const city = await coverage.assertPickupServiceable({
        lat: FAR_AWAY.lat,
        lng: FAR_AWAY.lng,
        vehicleTypeId,
      });
      assert.equal(city.code, 'GLOBAL', 'an unconfigured platform must still be able to sell');
    });

    it('refuses a pickup outside coverage once coverage exists', async () => {
      await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
      await assert.rejects(
        () =>
          coverage.assertPickupServiceable({
            lat: FAR_AWAY.lat,
            lng: FAR_AWAY.lng,
            vehicleTypeId,
          }),
        /service area/i,
        'one drawn polygon makes coverage real and enforceable',
      );
    });

    it('serves a pickup inside coverage once coverage exists', async () => {
      await ensureCityWithBoundary('SGR', 'Srinagar', CITY_POLYGON);
      const city = await coverage.assertPickupServiceable({
        lat: IN_CITY.lat,
        lng: IN_CITY.lng,
        vehicleTypeId,
      });
      assert.equal(city.code, 'SGR');
    });
  });

  /// The HTTP-level proof. Everything above exercises the services directly;
  /// this books a real ride through the API and reads the column back, so the
  /// raw INSERT in `RideRequestRepository` — which had to be edited by hand
  /// because of the PostGIS `pickup_location` column — is proven to carry the
  /// value rather than silently dropping it.
  describe('booking records the rule it was quoted on (FR-002, end to end)', () => {
    it('persists pricingRuleId on the ride request', async () => {
      const { airportZoneId } = await seedNestedZones();
      await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 30 });
      const zoneRuleId = await createPricingRuleDirect({
        vehicleTypeId,
        cityCode: 'SGR',
        baseFare: 120,
        perKmRate: 10,
        serviceZoneId: airportZoneId,
      });

      const customer = await loginAs(app, '+919876710055');
      // `createRequest` refuses with 422 INCOMPLETE_PROFILE without a name.
      await completeProfile(customer.userId);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: { ...customer.authHeader, 'idempotency-key': randomUUID() },
        payload: {
          vehicleTypeId,
          pickupLat: AIRPORT.lat,
          pickupLng: AIRPORT.lng,
          dropLat: IN_CITY.lat,
          dropLng: IN_CITY.lng,
        },
      });
      assert.equal(response.statusCode, 200, response.payload);

      const requestId = response.json().data.id as string;
      const row = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(
        row.pricingRuleId,
        zoneRuleId,
        'the request must record the zone rule its quote was priced on',
      );
    });
  });

  /// FR-039. The acceptance criterion is "a constant number of spatial queries,
  /// independent of N" — so it is asserted by counting them, not by reading the
  /// code and believing it.
  ///
  /// Every spatial predicate in this path goes through `$queryRaw`, so counting
  /// those calls counts the PostGIS work. The catalog seeds four categories; a
  /// quote for all four must cost the same as a quote for one.
  describe('quote cost does not grow with the catalog (FR-039)', () => {
    it('runs the same number of spatial queries for one category as for four', async () => {
      await seedNestedZones();
      await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 50 });
      const customer = await loginAs(app, '+919876710077');
      await completeProfile(customer.userId);

      const client = db().client as unknown as { $queryRaw: (...args: unknown[]) => unknown };
      const original = client.$queryRaw.bind(client);
      let rawCalls = 0;
      const count = async (): Promise<number> => {
        rawCalls = 0;
        client.$queryRaw = ((...args: unknown[]) => {
          rawCalls += 1;
          return original(...args);
        }) as typeof client.$queryRaw;
        return rawCalls;
      };

      try {
        await count();
        const single = await app.inject({
          method: 'POST',
          url: '/api/v1/rides/quote',
          headers: customer.authHeader,
          payload: {
            pickupLat: AIRPORT.lat,
            pickupLng: AIRPORT.lng,
            dropLat: IN_CITY.lat,
            dropLng: IN_CITY.lng,
            vehicleTypeId,
          },
        });
        assert.equal(single.statusCode, 200, single.payload);
        const forOne = rawCalls;

        await count();
        const all = await app.inject({
          method: 'POST',
          url: '/api/v1/rides/quote',
          headers: customer.authHeader,
          payload: {
            pickupLat: AIRPORT.lat,
            pickupLng: AIRPORT.lng,
            dropLat: IN_CITY.lat,
            dropLng: IN_CITY.lng,
          },
        });
        assert.equal(all.statusCode, 200, all.payload);
        const forAll = rawCalls;
        const categories = (all.json().data.options as unknown[]).length;

        assert.ok(categories >= 4, `expected the seeded ladder, got ${categories}`);
        assert.equal(
          forAll,
          forOne,
          `spatial queries must not scale with the catalog: ${forOne} for 1, ${forAll} for ${categories}`,
        );
      } finally {
        client.$queryRaw = original as typeof client.$queryRaw;
      }
    });
  });

  describe('surge multiplier stays clamped (FR-011)', () => {
    it('refuses to price above the policy ceiling whatever the caller passes', async () => {
      await createPricingRuleDirect({ vehicleTypeId, cityCode: 'GLOBAL', baseFare: 100 });
      const card = await pricing.rateCardForTypeId(vehicleTypeId, 'GLOBAL');

      const sane = await pricing.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId,
        rateCard: card,
        surgeMultiplier: 2,
      });
      const absurd = await pricing.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId,
        rateCard: card,
        surgeMultiplier: 50,
      });
      assert.equal(absurd.surgeMultiplier, 2, 'the multiplier must be clamped to the ceiling');
      assert.equal(absurd.totalFare, sane.totalFare, 'and the fare must be identical');

      const negative = await pricing.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId,
        rateCard: card,
        surgeMultiplier: -5,
      });
      assert.equal(negative.surgeMultiplier, 1, 'and it must never discount below the floor');
    });
  });
});
