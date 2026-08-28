import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pricingConfig } from '../../../src/config/pricing/pricing.config.js';
import { PricingService, ZeroDistanceTripError } from '../../../src/modules/pricing';
import type { PricingRuleRepository } from '../../../src/modules/pricing/repositories/pricing-rule.repository.js';
import type { PricingRule } from '../../../src/generated/prisma/index.js';

type PricingRuleOverrides = Partial<Record<keyof PricingRule, unknown>>;

function pricingRule(overrides: PricingRuleOverrides = {}): PricingRule {
  return {
    id: 'rule-1',
    vehicleTypeId: 'v-type-1',
    cityCode: 'GLOBAL',
    serviceType: null,
    serviceZoneId: null,
    currency: 'INR',
    minimumFare: null,
    baseFare: null,
    perKmRate: null,
    perMinuteRate: null,
    waitingPerMin: null,
    freeWaitingMin: 3,
    includedKm: null,
    bookingFee: null,
    platformFeePct: null,
    taxRatePct: null,
    commissionRatePct: null,
    nightMultiplier: null,
    version: 1,
    isActive: true,
    effectiveFrom: new Date(),
    effectiveTo: null,
    createdBy: null,
    createdAt: new Date(),
    ...overrides,
  } as unknown as PricingRule;
}

const rules = new Map<string, PricingRule>([['v-type-1', pricingRule()]]);

const pricingRuleRepository = {
  findBestActiveRule: async ({
    vehicleTypeId,
    cityCode,
  }: {
    vehicleTypeId: string;
    cityCode?: string;
  }) => {
    if (cityCode && cityCode !== 'GLOBAL') {
      return null;
    }
    return rules.get(vehicleTypeId) ?? null;
  },
  findActiveRule: async (vehicleTypeId: string, cityCode: string) => {
    if (cityCode === 'GLOBAL') {
      return rules.get(vehicleTypeId) ?? null;
    }
    return null;
  },
} as unknown as PricingRuleRepository;

const pricingService = new PricingService(pricingRuleRepository);

describe('Itemized fare calculation', () => {
  it('computes an itemized quote whose parts reconcile to the total', async () => {
    const result = await pricingService.calculateFareQuote({
      pickupLat: 28.6139,
      pickupLng: 77.209,
      dropLat: 28.6315,
      dropLng: 77.2167,
      vehicleTypeId: 'v-type-1',
      surgeMultiplier: 1.5,
    });

    assert.ok(result.totalFare > 50);
    assert.equal(result.surgeMultiplier, 1.5);
    assert.ok(result.driverEarning > 0);
    assert.ok(result.platformCommission > 0);

    assert.equal(
      Math.round((result.driverEarning + result.platformCommission) * 100) / 100,
      result.totalFare,
    );
  });

  it('refuses to quote without drop coordinates instead of assuming 5 km', async () => {
    await assert.rejects(
      () =>
        pricingService.calculateFareQuote({
          pickupLat: 28.6139,
          pickupLng: 77.209,
          vehicleTypeId: 'v-type-1',
        }),
      /drop coordinates/i,
    );
  });

  it('includes booking fee and respects free waiting minutes', async () => {
    rules.set(
      'v-type-fees',
      pricingRule({
        vehicleTypeId: 'v-type-fees',
        bookingFee: 10,
        freeWaitingMin: 5,
        waitingPerMin: 2,
        baseFare: 50,
        perKmRate: 0,
        perMinuteRate: 0,
        minimumFare: 0,
        platformFeePct: 0,
        taxRatePct: 0,
        commissionRatePct: 10,
      }),
    );

    const withWait = await pricingService.calculateFinalFare({
      actualDistanceKm: 0,
      actualDurationMin: 0,
      waitingMinutes: 8,
      vehicleTypeId: 'v-type-fees',
    });
    assert.equal(withWait.bookingFee, 10);
    assert.equal(withWait.waitingCharge, 6);
  });

  it('applies tax and commission from the rate card', async () => {
    rules.set(
      'v-type-tax',
      pricingRule({
        vehicleTypeId: 'v-type-tax',
        baseFare: 100,
        perKmRate: 0,
        perMinuteRate: 0,
        minimumFare: 0,
        bookingFee: 0,
        platformFeePct: 10,
        taxRatePct: 5,
        commissionRatePct: 20,
      }),
    );

    const result = await pricingService.calculateFinalFare({
      actualDistanceKm: 0,
      actualDurationMin: 0,
      vehicleTypeId: 'v-type-tax',
    });

    assert.equal(result.taxAmount, 5);
    assert.equal(result.platformFee, 10);
    assert.equal(result.platformCommission, Math.round(result.totalFare * 0.2 * 100) / 100);
  });
});

describe('Final fare (billed on actual trip values)', () => {
  it('charges a 40 km ride more than a 2 km ride', async () => {
    const short = await pricingService.calculateFinalFare({
      actualDistanceKm: 2,
      actualDurationMin: 8,
      vehicleTypeId: 'v-type-1',
    });
    const long = await pricingService.calculateFinalFare({
      actualDistanceKm: 40,
      actualDurationMin: 75,
      vehicleTypeId: 'v-type-1',
    });

    assert.ok(
      long.totalFare > short.totalFare,
      `40km (${long.totalFare}) must cost more than 2km (${short.totalFare})`,
    );

    assert.ok(long.totalFare > short.totalFare * 3);
  });

  it('bills the distance it is given, not an estimate', async () => {
    const result = await pricingService.calculateFinalFare({
      actualDistanceKm: 12.5,
      actualDurationMin: 30,
      vehicleTypeId: 'v-type-1',
    });
    assert.equal(result.estimatedDistanceKm, 12.5);
    assert.equal(result.estimatedDurationMin, 30);
  });

  it('prices vehicle types differently from their own pricing columns', async () => {
    const card = pricingService.rateCardFor(pricingRule());
    rules.set(
      'premium',
      pricingRule({
        vehicleTypeId: 'premium',
        perKmRate: card.perKm * 2,
        baseFare: card.baseFare * 2,
      }),
    );

    try {
      const standard = await pricingService.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId: 'v-type-1',
      });
      const expensive = await pricingService.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId: 'premium',
      });
      assert.ok(expensive.totalFare > standard.totalFare);
    } finally {
      rules.delete('premium');
    }
  });

  it('falls back per field, so a type that prices only per-km keeps sane defaults', () => {
    const fallback = pricingService.rateCardFor(null);
    const partial = pricingService.rateCardFor(pricingRule({ perKmRate: 99 }));

    assert.equal(partial.perKm, 99);
    assert.equal(partial.baseFare, fallback.baseFare);
    assert.equal(partial.minimumFare, fallback.minimumFare);
    assert.equal(partial.commissionRatePct, fallback.commissionRatePct);
  });

  it('prices an unknown vehicle type on the platform default rather than throwing', async () => {
    const result = await pricingService.calculateFinalFare({
      actualDistanceKm: 10,
      actualDurationMin: 20,
      vehicleTypeId: 'does-not-exist',
    });
    assert.ok(result.totalFare > 0);
  });

  it('never bills below the minimum fare', async () => {
    const result = await pricingService.calculateFinalFare({
      actualDistanceKm: 0,
      actualDurationMin: 0,
      vehicleTypeId: 'v-type-1',
    });
    assert.ok(result.totalFare >= pricingService.rateCardFor(pricingRule()).minimumFare);
  });

  it('rejects negative or non-finite trip values rather than pricing them', async () => {
    await assert.rejects(
      () =>
        pricingService.calculateFinalFare({
          actualDistanceKm: -5,
          actualDurationMin: 10,
          vehicleTypeId: 'v-type-1',
        }),
      /actualDistanceKm/,
    );
    await assert.rejects(
      () =>
        pricingService.calculateFinalFare({
          actualDistanceKm: Number.NaN,
          actualDurationMin: 10,
          vehicleTypeId: 'v-type-1',
        }),
      /actualDistanceKm/,
    );
  });

  it('keeps money to two decimal places', async () => {
    const result = await pricingService.calculateFinalFare({
      actualDistanceKm: 7.77,
      actualDurationMin: 23,
      vehicleTypeId: 'v-type-1',
    });
    for (const [field, value] of Object.entries(result)) {
      if (typeof value !== 'number') continue;
      assert.equal(
        Math.round(value * 100) / 100,
        value,
        `${field} carries sub-paise precision: ${value}`,
      );
    }
  });
});

/// `Ride.waitTimeMin` is read by `completeRide` and written by nothing, so
/// `waitingMinutes` is 0 on every fare the platform has ever computed and none
/// of this is reachable today. It is tested because the formula has to be right
/// *before* something starts measuring the wait — otherwise the first rider
/// billed for waiting is overcharged for the grace period they were promised.
describe('waiting charges honour the free period', () => {
  const rateCard = {
    ...pricingConfig.defaultRateCard,
    freeWaitingMinutes: 3,
    perWaitingMinute: 3,
  };

  async function waitingChargeFor(waitingMinutes: number): Promise<number> {
    const result = await pricingService.calculateFinalFare({
      actualDistanceKm: 5,
      actualDurationMin: 10,
      vehicleTypeId: 'v-type-1',
      waitingMinutes,
      rateCard,
    });
    return result.waitingCharge;
  }

  it('charges nothing for a wait inside the free period', async () => {
    assert.equal(await waitingChargeFor(0), 0);
    assert.equal(await waitingChargeFor(2), 0);
    // The boundary: three free minutes means the third is still free.
    assert.equal(await waitingChargeFor(3), 0);
  });

  it('charges only the minutes beyond the free period', async () => {
    // 10 minutes waited, 3 free, 7 billable at 3/min.
    assert.equal(await waitingChargeFor(10), 21);
    assert.equal(await waitingChargeFor(4), 3);
  });

  it('never returns a negative charge for a short wait', async () => {
    assert.equal(await waitingChargeFor(1), 0);
  });

  it('adds the waiting charge to the total, once', async () => {
    const withoutWait = await pricingService.calculateFinalFare({
      actualDistanceKm: 5,
      actualDurationMin: 10,
      vehicleTypeId: 'v-type-1',
      rateCard,
    });
    const withWait = await pricingService.calculateFinalFare({
      actualDistanceKm: 5,
      actualDurationMin: 10,
      vehicleTypeId: 'v-type-1',
      waitingMinutes: 10,
      rateCard,
    });
    assert.equal(withWait.waitingCharge, 21);
    assert.ok(withWait.totalFare > withoutWait.totalFare);
  });
});

/// A booking whose drop was its pickup priced at the minimum fare and went out
/// to dispatch: a driver sent to a customer already standing at their
/// destination, and the customer charged the floor for a journey that could not
/// happen.
describe('a trip with nowhere to go (L-6)', () => {
  const BLR = { latitude: 12.9716, longitude: 77.5946 };

  function estimate(drop: { latitude: number; longitude: number }) {
    return pricingService.estimateTrip({
      pickupLat: BLR.latitude,
      pickupLng: BLR.longitude,
      dropLat: drop.latitude,
      dropLng: drop.longitude,
    });
  }

  it('refuses a drop that is the pickup', () => {
    assert.throws(() => estimate(BLR), ZeroDistanceTripError);
  });

  it('refuses a drop too close to price, not only an exact match', () => {
    // ~1m north — a second GPS read of the same spot, which rounds to no
    // distance at all once the road factor and 2dp rounding are applied.
    assert.throws(
      () => estimate({ latitude: BLR.latitude + 0.00001, longitude: BLR.longitude }),
      ZeroDistanceTripError,
    );
  });

  it('is refused with a code a client can act on, not a 500', () => {
    try {
      estimate(BLR);
      assert.fail('expected a refusal');
    } catch (err) {
      const coded = err as { code?: string; statusCode?: number };
      assert.equal(coded.code, 'TRIP_HAS_NO_DISTANCE');
      assert.equal(coded.statusCode, 400, 'a client mistake, not a server fault');
    }
  });

  it('still prices a real trip', () => {
    // ~1km north.
    const trip = estimate({ latitude: BLR.latitude + 0.009, longitude: BLR.longitude });
    assert.ok(trip.distanceKm > 0);
    assert.ok(trip.durationMin >= 1);
  });

  it('never refuses a completed ride that reports no distance', async () => {
    // The driver has finished driving; refusing here would leave them unable to
    // close the ride. Guarding the quote is not the same as guarding the bill.
    const fare = await pricingService.calculateFinalFare({
      actualDistanceKm: 0,
      actualDurationMin: 5,
      vehicleTypeId: 'v-type-1',
    });
    assert.ok(fare.totalFare > 0);
  });
});

/// `createQuote` estimates the journey once for the response, then priced every
/// active category in a loop — and each pass re-ran the same haversine over the
/// same two points. The journey does not change between a bike and a premium
/// cab.
describe('a quote estimates the journey once (L-4)', () => {
  const BLR = { latitude: 12.9716, longitude: 77.5946 };
  const NEARBY = { latitude: 12.9806, longitude: 77.5946 };

  function quote(trip?: { distanceKm: number; durationMin: number }) {
    return pricingService.calculateFareQuote({
      pickupLat: BLR.latitude,
      pickupLng: BLR.longitude,
      dropLat: NEARBY.latitude,
      dropLng: NEARBY.longitude,
      vehicleTypeId: 'v-type-1',
      ...(trip !== undefined ? { trip } : {}),
    });
  }

  it('prices the trip it was handed rather than re-deriving one', async () => {
    // Coordinates a kilometre apart, but the caller says fifty. If the supplied
    // trip were ignored the fare would come out at the short one.
    const supplied = await quote({ distanceKm: 50, durationMin: 100 });
    const derived = await quote();

    assert.ok(
      supplied.totalFare > derived.totalFare * 5,
      `supplied ${supplied.totalFare} should dwarf derived ${derived.totalFare}`,
    );
  });

  it('agrees with the estimate it would have made when none is handed in', async () => {
    const trip = pricingService.estimateTrip({
      pickupLat: BLR.latitude,
      pickupLng: BLR.longitude,
      dropLat: NEARBY.latitude,
      dropLng: NEARBY.longitude,
    });

    const supplied = await quote(trip);
    const derived = await quote();

    // The optimisation must be invisible in the price — passing the trip in is
    // the same journey, not a different one.
    assert.equal(supplied.totalFare, derived.totalFare);
  });
});
