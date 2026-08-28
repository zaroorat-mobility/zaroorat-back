import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PricingService } from '../../../src/modules/pricing';
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
