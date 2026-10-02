import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateFinancials,
  calculatePercentageChange,
} from '../../../src/modules/admin/dashboard/financial.calculator.js';
import {
  formatIstDate,
  formatIstWeekday,
} from '../../../src/modules/admin/dashboard/dashboard.service.js';

describe('Operations Dashboard Financial Formulas (Unit Tests)', () => {
  it('1. Canonical Example from Spec: Gross ₹100k, Commission ₹10k, Subscription ₹5k', () => {
    const result = calculateFinancials({
      grossRideValue: 100000,
      rideCommission: 10000,
      subscriptionRevenue: 5000,
      platformFees: 0,
    });

    assert.equal(
      result.platformRevenue,
      15000,
      'Platform Revenue must be Commission (₹10k) + Subscription (₹5k) = ₹15,000',
    );
    assert.equal(
      result.driverRideCollections,
      90000,
      'Driver Ride Collections must be Gross (₹100k) - Commission (₹10k) = ₹90,000',
    );
    assert.equal(result.grossRideValue, 100000);
    assert.equal(result.rideDeductions, 10000);
    assert.equal(result.subscriptionRevenue, 5000);
  });

  it('2. Zero Rides: No rides completed, only driver subscriptions collected', () => {
    const result = calculateFinancials({
      grossRideValue: 0,
      rideCommission: 0,
      subscriptionRevenue: 2500,
      platformFees: 0,
    });

    assert.equal(result.platformRevenue, 2500, 'Platform revenue from subscriptions only');
    assert.equal(result.grossRideValue, 0, 'No ride fare collected');
    assert.equal(result.driverRideCollections, 0, 'Zero driver collections');
    assert.equal(result.rideDeductions, 0);
  });

  it('3. Subscription Only: Ensures subscription is NOT subtracted from driver collections', () => {
    const result = calculateFinancials({
      grossRideValue: 5000,
      rideCommission: 0,
      subscriptionRevenue: 1000, // driver paid ₹1,000 for monthly subscription
      platformFees: 0,
    });

    assert.equal(result.platformRevenue, 1000, 'Platform revenue = ₹1,000');
    assert.equal(
      result.driverRideCollections,
      5000,
      'Driver collections must remain ₹5,000 because subscription is NOT deducted from ride fares',
    );
  });

  it('4. Commission Only: No subscription plans, only ride commissions', () => {
    const result = calculateFinancials({
      grossRideValue: 50000,
      rideCommission: 5000,
      subscriptionRevenue: 0,
      platformFees: 0,
    });

    assert.equal(result.platformRevenue, 5000);
    assert.equal(result.driverRideCollections, 45000);
    assert.equal(result.grossRideValue, 50000);
  });

  it('5. Multiple Ledger Entries: Aggregates commission, ride platform fees, and subscriptions', () => {
    // Simulates summing up multiple ledger entries:
    // Commission entries: 200 + 150 + 350 = 700
    // Platform fees: 50 + 25 = 75
    // Subscription entries: 499 + 199 = 698
    // Completed trip fares: 1800 + 1200 + 3500 = 6500
    const commissions = [200, 150, 350].reduce((a, b) => a + b, 0);
    const fees = [50, 25].reduce((a, b) => a + b, 0);
    const subscriptions = [499, 199].reduce((a, b) => a + b, 0);
    const fares = [1800, 1200, 3500].reduce((a, b) => a + b, 0);

    const result = calculateFinancials({
      grossRideValue: fares, // 6500
      rideCommission: commissions, // 700
      platformFees: fees, // 75
      subscriptionRevenue: subscriptions, // 698
    });

    assert.equal(result.platformRevenue, 700 + 75 + 698, 'Platform revenue = 1473');
    assert.equal(result.rideDeductions, 775, 'Ride deductions = 700 + 75');
    assert.equal(result.driverRideCollections, 6500 - 775, 'Driver ride collections = 5725');
  });

  it('6. Timezone Boundary: Evaluates Asia/Kolkata date cutoffs correctly around midnight', () => {
    // 11:59 PM IST on 2026-09-26 is 18:29 UTC on 2026-09-26
    const lateNightIst = new Date('2026-09-26T18:29:00.000Z');
    // 12:01 AM IST on 2026-09-27 is 18:31 UTC on 2026-09-26
    const earlyMorningIst = new Date('2026-09-26T18:31:00.000Z');

    assert.equal(formatIstDate(lateNightIst), '2026-09-26', '11:59 PM IST belongs to 2026-09-26');
    assert.equal(
      formatIstDate(earlyMorningIst),
      '2026-09-27',
      '12:01 AM IST belongs to 2026-09-27',
    );
    assert.equal(formatIstWeekday(lateNightIst), 'Sat');
    assert.equal(formatIstWeekday(earlyMorningIst), 'Sun');
  });

  it('7. Percentage Change: Accurately calculates positive, negative, and zero comparisons', () => {
    // Standard growth: 2841 vs 2401 -> +18.3%
    assert.equal(calculatePercentageChange(2841, 2401), 18.3);

    // Standard decrease: 32 vs 42 -> -23.8%
    assert.equal(calculatePercentageChange(32, 42), -23.8);

    // No change
    assert.equal(calculatePercentageChange(100, 100), 0);

    // Zero previous: no baseline, so no percentage (never an invented +100 %)
    assert.equal(calculatePercentageChange(50, 0), null);

    // Zero both: still no baseline
    assert.equal(calculatePercentageChange(0, 0), null);
  });
});
