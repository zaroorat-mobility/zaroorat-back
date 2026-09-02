import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PricingMetrics, PricingService } from '../../../src/modules/pricing';
import type { PricingRuleRepository } from '../../../src/modules/pricing/repositories/pricing-rule.repository.js';
import type { PricingRule } from '../../../src/generated/prisma/index.js';

/// P-1. The accepted quote is a ceiling on the final fare.
///
/// The bill is recomputed from measured distance and duration, so a trip that
/// sat in traffic used to cost more than the customer agreed to with nothing
/// bounding the difference.

type RuleOverrides = Partial<Record<keyof PricingRule, unknown>>;

function pricingRule(overrides: RuleOverrides = {}): PricingRule {
  return {
    id: 'rule-1',
    vehicleTypeId: 'vt',
    cityCode: 'GLOBAL',
    serviceType: null,
    serviceZoneId: null,
    currency: 'INR',
    minimumFare: 0,
    baseFare: 0,
    perKmRate: 0,
    perMinuteRate: 0,
    waitingPerMin: 0,
    freeWaitingMin: 3,
    bookingFee: 0,
    platformFeePct: 0,
    platformFeeFlat: 0,
    taxRatePct: 0,
    commissionRatePct: 0,
    version: 1,
    isActive: true,
    effectiveFrom: new Date(),
    effectiveTo: null,
    createdBy: null,
    createdAt: new Date(),
    ...overrides,
  } as unknown as PricingRule;
}

function serviceFor(rule: PricingRule): PricingService {
  const repo = {
    findById: async () => rule,
    findBestActiveRule: async () => rule,
  } as unknown as PricingRuleRepository;
  return new PricingService(repo, new PricingMetrics());
}

const BASE = {
  actualDistanceKm: 20,
  actualDurationMin: 60,
  vehicleTypeId: 'vt',
  pricingRuleId: 'rule-1',
};

describe('final fare ceiling (P-1)', () => {
  it('bills the uncapped fare when no ceiling is supplied', async () => {
    const service = serviceFor(pricingRule({ perKmRate: 10, perMinuteRate: 1 }));
    const fare = await service.calculateFinalFare(BASE);
    // 20km x 10 + 60min x 1
    assert.equal(fare.totalFare, 260);
    assert.equal(fare.discountAmount, 0);
  });

  it('leaves a fare already under the ceiling untouched', async () => {
    const service = serviceFor(pricingRule({ perKmRate: 10, perMinuteRate: 1 }));
    const fare = await service.calculateFinalFare({ ...BASE, fareCeiling: 400 });
    assert.equal(fare.totalFare, 260);
    assert.equal(fare.discountAmount, 0);
  });

  it('caps a fare that exceeds the ceiling, to the paisa', async () => {
    const service = serviceFor(pricingRule({ perKmRate: 10, perMinuteRate: 1 }));
    const fare = await service.calculateFinalFare({ ...BASE, fareCeiling: 200 });
    assert.equal(fare.totalFare, 200, 'the total lands exactly on the ceiling');
    assert.equal(fare.discountAmount, 60, 'the excess is carried as a discount');
  });

  it('hits the ceiling exactly with tax and a percentage platform fee applied', async () => {
    // Both are computed from the post-discount net, so a naive clamp of the
    // total would leave the components not summing to it.
    const service = serviceFor(
      pricingRule({ perKmRate: 10, perMinuteRate: 1, taxRatePct: 5, platformFeePct: 10 }),
    );
    const uncapped = await service.calculateFinalFare(BASE);
    assert.equal(uncapped.totalFare, 299, '260 + 5% tax + 10% fee');

    const capped = await service.calculateFinalFare({ ...BASE, fareCeiling: 250 });
    assert.equal(capped.totalFare, 250);
    assert.equal(capped.subtotal, uncapped.subtotal, 'the cap moves the discount, not the fare');
    assert.equal(
      Math.round(
        (capped.subtotal - capped.discountAmount + capped.taxAmount + capped.platformFee) * 100,
      ) / 100,
      capped.totalFare,
      'net + tax + fee still equals the total',
    );
  });

  it('hits the ceiling exactly with a flat platform fee', async () => {
    const service = serviceFor(
      pricingRule({ perKmRate: 10, perMinuteRate: 1, taxRatePct: 5, platformFeeFlat: 15 }),
    );
    const capped = await service.calculateFinalFare({ ...BASE, fareCeiling: 220 });
    assert.equal(capped.totalFare, 220);
  });

  it('pays the driver on the pre-cap fare — the platform absorbs the cap', async () => {
    const rule = pricingRule({ perKmRate: 10, perMinuteRate: 1, commissionRatePct: 20 });
    const uncapped = await serviceFor(rule).calculateFinalFare(BASE);
    const capped = await serviceFor(rule).calculateFinalFare({ ...BASE, fareCeiling: 200 });

    assert.equal(capped.driverEarning, uncapped.driverEarning, 'traffic is not the driver’s fault');
    assert.ok(
      capped.platformCommission < uncapped.platformCommission,
      'the platform made the promise and pays for it',
    );
  });

  it('keeps the FR-006 identity true under a cap', async () => {
    const service = serviceFor(
      pricingRule({ perKmRate: 10, perMinuteRate: 1, taxRatePct: 5, platformFeePct: 10 }),
    );
    const fare = await service.calculateFinalFare({ ...BASE, fareCeiling: 250 });
    const recomposed =
      fare.driverEarning + fare.platformCommission + fare.platformFee + fare.taxAmount;
    assert.equal(Math.round(recomposed * 100) / 100, fare.totalFare);
  });

  it('never bills below zero, whatever ceiling is passed', async () => {
    const service = serviceFor(pricingRule({ perKmRate: 10, perMinuteRate: 1 }));
    const fare = await service.calculateFinalFare({ ...BASE, fareCeiling: 0 });
    assert.ok(fare.totalFare >= 0, `total was ${fare.totalFare}`);
    assert.ok(fare.discountAmount <= fare.subtotal);
  });
});
