import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PricingMetrics, PricingService } from '../../../src/modules/pricing';
import type { PricingRuleRepository } from '../../../src/modules/pricing/repositories/pricing-rule.repository.js';
import type { PricingRule } from '../../../src/generated/prisma/index.js';
import type { ItemizedFareResult } from '../../../src/modules/pricing/domain/pricing.types.js';

/// Phase 2 — BD-1 A and BD-2 A.
///
/// These are the numbers that decide what every driver is paid and what the
/// platform keeps, so they are asserted as arithmetic rather than as remembered
/// constants: the identity in FR-006 has to hold for *every* case below, not
/// just the ones someone thought to write down.

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

/// A service whose only rule is the one handed in, so a case reads as its rate
/// card and nothing else.
function serviceFor(rule: PricingRule): PricingService {
  const repository = {
    findBestActiveRule: async () => rule,
    findActiveRule: async () => rule,
    findById: async () => rule,
  } as unknown as PricingRuleRepository;
  return new PricingService(repository, new PricingMetrics());
}

/// FR-006, asserted on every result this file produces.
function assertReconciles(fare: ItemizedFareResult): void {
  const parts = fare.driverEarning + fare.platformCommission + fare.platformFee + fare.taxAmount;
  assert.equal(
    Math.round(parts * 100) / 100,
    fare.totalFare,
    `driverEarning ${fare.driverEarning} + platformCommission ${fare.platformCommission} + ` +
      `platformFee ${fare.platformFee} + taxAmount ${fare.taxAmount} must equal ` +
      `totalFare ${fare.totalFare}`,
  );
}

/// A ride whose fare is exactly `baseFare`, so each case states one number and
/// the arithmetic under test is not buried in a distance calculation.
async function fareOf(
  rule: PricingRule,
  params: { discountAmount?: number } = {},
): Promise<ItemizedFareResult> {
  const fare = await serviceFor(rule).calculateFinalFare({
    actualDistanceKm: 0,
    actualDurationMin: 0,
    vehicleTypeId: 'vt',
    ...params,
  });
  assertReconciles(fare);
  return fare;
}

describe('fare split (BD-1 A, BD-2 A)', () => {
  /// The default card from the spec: 5% tax, 20% commission, 15 flat platform
  /// fee, on a 300 ride.
  const defaultCard = pricingRule({
    baseFare: 300,
    taxRatePct: 5,
    commissionRatePct: 20,
    platformFeePct: 0,
    platformFeeFlat: 15,
  });

  describe('commission is levied on ride revenue only (FR-007, BD-1 A)', () => {
    it('splits the worked example the way the decision says', async () => {
      const fare = await fareOf(defaultCard);

      // Tax is remitted, not earned. The platform fee is already the platform's.
      // Commission on either is not defensible to a driver or an auditor.
      assert.equal(fare.subtotal, 300);
      assert.equal(fare.taxAmount, 15);
      assert.equal(fare.platformFee, 15);
      assert.equal(fare.totalFare, 330);
      assert.equal(fare.driverEarning, 240);
      assert.equal(fare.platformCommission, 60);
    });

    it('is what the previous behaviour got wrong, by 6.00 on this ride', async () => {
      const fare = await fareOf(defaultCard);
      // Before: commission = totalFare x 20% = 330 x 0.2 = 66.00, driver 264.00.
      // The driver was credited with the tax and the platform's own fee, then
      // charged commission on both.
      assert.notEqual(fare.platformCommission, 66);
      assert.notEqual(fare.driverEarning, 264);
      assert.equal(fare.platformCommission, 60);
    });

    it('excludes the booking fee from the driver base', async () => {
      const withBookingFee = pricingRule({
        baseFare: 280,
        bookingFee: 20,
        commissionRatePct: 20,
        taxRatePct: 0,
        platformFeeFlat: 0,
      });
      const fare = await fareOf(withBookingFee);

      // The ride still earned 300, but 20 of it is a platform charge rather than
      // fare for the journey, so the driver's base is 280.
      assert.equal(fare.subtotal, 300);
      assert.equal(fare.bookingFee, 20);
      assert.equal(fare.driverEarning, 224);
      assert.equal(fare.platformCommission, 76);
    });

    it('never charges commission on tax, at any tax rate', async () => {
      for (const taxRatePct of [0, 5, 12, 18, 28]) {
        const fare = await fareOf(
          pricingRule({ baseFare: 300, taxRatePct, commissionRatePct: 20, platformFeeFlat: 0 }),
        );
        // The driver's earning is a function of the ride, not of the tax regime.
        assert.equal(fare.driverEarning, 240, `driver earning moved at ${taxRatePct}% tax`);
      }
    });
  });

  describe('the platform bears a promotional discount (FR-008, BD-2 A)', () => {
    it('pays the driver on the pre-discount base', async () => {
      const fare = await fareOf(defaultCard, { discountAmount: 50 });

      assert.equal(fare.discountAmount, 50);
      // Customer pays 250 + 12.50 tax + 15 fee.
      assert.equal(fare.totalFare, 277.5);
      // The driver is untouched by the campaign: still 80% of the 300 ride.
      assert.equal(fare.driverEarning, 240);
      // The platform's gross 60 absorbs the whole 50.
      assert.equal(fare.platformCommission, 10);
    });

    it('leaves the driver exactly where an undiscounted ride would', async () => {
      const without = await fareOf(defaultCard);
      const with50 = await fareOf(defaultCard, { discountAmount: 50 });
      assert.equal(with50.driverEarning, without.driverEarning);
      // The entire difference in what the platform keeps is the discount.
      assert.equal(
        Math.round((without.platformCommission - with50.platformCommission) * 100) / 100,
        50,
      );
    });

    it('lets the platform go negative rather than quietly charging the driver', async () => {
      // A discount larger than the platform's margin means the platform really
      // does pay out more than it collected. That is what BD-2 A chose; hiding it
      // by clamping to zero would silently push the cost back onto the driver.
      const fare = await fareOf(defaultCard, { discountAmount: 200 });
      assert.equal(fare.driverEarning, 240);
      assert.ok(
        fare.platformCommission < 0,
        `expected a negative residual, got ${fare.platformCommission}`,
      );
    });
  });

  describe('the minimum-fare floor binds before the discount (FR-008)', () => {
    const shortTrip = pricingRule({
      baseFare: 40,
      minimumFare: 100,
      taxRatePct: 0,
      commissionRatePct: 20,
      platformFeeFlat: 0,
    });

    it('applies the floor to the fare, then the discount to the floored fare', async () => {
      const fare = await fareOf(shortTrip, { discountAmount: 30 });

      // Previously: max(100, 40 - 30) = 100, so the customer paid the full
      // minimum, the promotion reduced the bill by nothing, and the redemption
      // was still written and the coupon still burned.
      assert.equal(fare.totalFare, 70);
      assert.equal(fare.discountAmount, 30);
    });

    it('records the discount actually granted, not the one requested', async () => {
      // A 500 discount on a 100 floor cannot grant 500. Recording 500 would
      // overstate the campaign's cost in every report that sums the column.
      const fare = await fareOf(shortTrip, { discountAmount: 500 });
      assert.equal(fare.totalFare, 0);
      assert.equal(fare.discountAmount, 100);
    });

    it('never lets a discount make the customer owe a negative amount', async () => {
      for (const discountAmount of [0, 50, 100, 150, 1000]) {
        const fare = await fareOf(shortTrip, { discountAmount });
        assert.ok(fare.totalFare >= 0, `total went negative at a ${discountAmount} discount`);
        assert.ok(
          fare.discountAmount <= 100,
          `granted ${fare.discountAmount} against a floor of 100`,
        );
      }
    });
  });

  describe('the platform fee comes from the rule (FR-009)', () => {
    it('honours a rule that sets the fee to zero', async () => {
      // The bug: `platformFeePct > 0 ? pct : flat` fell through to the env's flat
      // fee, and the rate card copied that flat fee from config even when a rule
      // had matched. So "this city charges no platform fee" was inexpressible.
      const noFee = pricingRule({
        baseFare: 300,
        platformFeePct: 0,
        platformFeeFlat: 0,
        taxRatePct: 0,
        commissionRatePct: 20,
      });
      const fare = await fareOf(noFee);
      assert.equal(fare.platformFee, 0);
      assert.equal(fare.totalFare, 300);
    });

    it('prefers a percentage when the rule sets one', async () => {
      const pctFee = pricingRule({
        baseFare: 300,
        platformFeePct: 10,
        platformFeeFlat: 99,
        taxRatePct: 0,
        commissionRatePct: 0,
      });
      const fare = await fareOf(pctFee);
      assert.equal(fare.platformFee, 30);
    });

    it('uses the rule flat fee rather than the environment default', async () => {
      const flatFee = pricingRule({
        baseFare: 300,
        platformFeePct: 0,
        platformFeeFlat: 7,
        taxRatePct: 0,
        commissionRatePct: 0,
      });
      const fare = await fareOf(flatFee);
      assert.equal(fare.platformFee, 7);
    });
  });

  describe('money arithmetic does not drift (FR-010)', () => {
    it('reconciles across rates chosen to be unrepresentable in binary', async () => {
      // 0.1 + 0.2 !== 0.3 in a double, and the old code rounded after every one
      // of eight steps, so the errors compounded. Every combination below must
      // still satisfy FR-006 to the paise.
      for (const baseFare of [0.1, 33.33, 99.99, 1234.56]) {
        for (const taxRatePct of [5, 12.5, 18]) {
          for (const commissionRatePct of [15, 22.5, 33.33]) {
            for (const discountAmount of [0, 0.03, 7.77]) {
              const fare = await fareOf(
                pricingRule({
                  baseFare,
                  taxRatePct,
                  commissionRatePct,
                  platformFeePct: 3.5,
                  minimumFare: 0,
                }),
                { discountAmount },
              );
              // `fareOf` asserts FR-006 on every one of these.
              assert.ok(Number.isFinite(fare.totalFare));
            }
          }
        }
      }
    });

    it('keeps every money field to at most two decimal places', async () => {
      const fare = await fareOf(
        pricingRule({
          baseFare: 33.33,
          taxRatePct: 12.5,
          commissionRatePct: 33.33,
          platformFeePct: 3.5,
        }),
        { discountAmount: 0.03 },
      );

      for (const [field, value] of Object.entries(fare)) {
        if (typeof value !== 'number' || field === 'surgeMultiplier') continue;
        assert.equal(
          Math.round(value * 100) / 100,
          value,
          `${field} carries sub-paise precision: ${value}`,
        );
      }
    });
  });
});
