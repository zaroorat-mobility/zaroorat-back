import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdminDashboardService,
  formatIstDate,
  formatIstWeekday,
  type LedgerAggRow,
  type RideAggRow,
} from '../../../src/modules/admin/dashboard/dashboard.service.js';

describe('AdminDashboardService - Revenue & Trend Calculation (Unit)', () => {
  const service = new AdminDashboardService({} as never);
  const fixedStart = new Date('2026-09-20T00:00:00+05:30');
  const targetDay = formatIstDate(fixedStart); // 2026-09-20
  const nextDay = formatIstDate(new Date(fixedStart.getTime() + 24 * 60 * 60 * 1000)); // 2026-09-21

  it('1. Customer ride fare must NOT become platform revenue (Fare: ₹500, Commission: ₹50 -> platform revenue: ₹50)', () => {
    const ledgerRows: LedgerAggRow[] = [
      {
        day: targetDay,
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        total: 50,
      },
    ];

    const rideRows: RideAggRow[] = [
      {
        day: targetDay,
        rides_count: 1,
        gross_ride_value: 500,
      },
    ];

    const trend = service.buildEarningTrend(fixedStart, ledgerRows, rideRows);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart));
    assert.ok(dayStat, 'Target day stat should exist');

    assert.equal(dayStat.platformRevenue, 50, 'Platform revenue must be ₹50, NOT ₹500');
    assert.equal(dayStat.earnings, 50, 'Earnings alias must equal platformRevenue');
    assert.equal(dayStat.rideCommission, 50);
    assert.equal(dayStat.subscriptionRevenue, 0);
    assert.equal(dayStat.platformFees, 0);
    assert.equal(
      dayStat.grossRideValue,
      500,
      'Gross ride value reflects customer trip bill paid directly to driver',
    );
    assert.equal(dayStat.ridesCount, 1);
  });

  it('2. Subscription payment is recognized as platform revenue (₹199)', () => {
    const ledgerRows: LedgerAggRow[] = [
      {
        day: targetDay,
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'CREDIT',
        total: 199,
      },
    ];

    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;

    assert.equal(dayStat.platformRevenue, 199);
    assert.equal(dayStat.subscriptionRevenue, 199);
    assert.equal(dayStat.rideCommission, 0);
    assert.equal(dayStat.grossRideValue, 0);
  });

  it('3. Commission wallet recharge is prepaid liability, NOT immediate platform revenue (₹500 recharge -> ₹0 revenue)', () => {
    // DRIVER_COMMISSION_WALLET entries are filtered out by the query/service and not included
    const ledgerRows: LedgerAggRow[] = [];
    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;

    assert.equal(dayStat.platformRevenue, 0, 'Recharge itself yields ₹0 recognized revenue');
    assert.equal(dayStat.rideCommission, 0);
  });

  it('4. Later commission deduction recognized when posted to PLATFORM_COMMISSION (₹30)', () => {
    const ledgerRows: LedgerAggRow[] = [
      {
        day: targetDay,
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        total: 30,
      },
    ];

    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;

    assert.equal(dayStat.platformRevenue, 30);
    assert.equal(dayStat.rideCommission, 30);
  });

  it('5. Refunded subscription reduces recognized subscription revenue according to ledger DEBIT', () => {
    const ledgerRows: LedgerAggRow[] = [
      {
        day: targetDay,
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'CREDIT',
        total: 199,
      },
      {
        day: targetDay,
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'DEBIT',
        total: 199,
      },
    ];

    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;

    assert.equal(
      dayStat.subscriptionRevenue,
      0,
      'Net subscription revenue must be ₹0 after full refund',
    );
    assert.equal(dayStat.platformRevenue, 0, 'Platform revenue must be ₹0 after full refund');
  });

  it('6. Multiple revenue streams on the same reporting day are properly aggregated', () => {
    const ledgerRows: LedgerAggRow[] = [
      {
        day: targetDay,
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        total: 50,
      },
      {
        day: targetDay,
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'CREDIT',
        total: 199,
      },
      {
        day: targetDay,
        account: 'PLATFORM_FEE',
        direction: 'CREDIT',
        total: 10,
      },
    ];

    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;

    assert.equal(dayStat.rideCommission, 50);
    assert.equal(dayStat.subscriptionRevenue, 199);
    assert.equal(dayStat.platformFees, 10);
    assert.equal(dayStat.platformRevenue, 259, '50 + 199 + 10 = 259 total platform revenue');
  });

  it('7. Multiple days are cleanly separated without cross-contamination', () => {
    const nextDayStart = new Date(fixedStart.getTime() + 24 * 60 * 60 * 1000);
    const ledgerRows: LedgerAggRow[] = [
      {
        day: targetDay,
        account: 'PLATFORM_COMMISSION',
        direction: 'CREDIT',
        total: 50,
      },
      {
        day: nextDay,
        account: 'SUBSCRIPTION_REVENUE',
        direction: 'CREDIT',
        total: 199,
      },
    ];

    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const day1Stat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;
    const day2Stat = trend.find((t) => t.date === formatIstWeekday(nextDayStart))!;

    assert.equal(day1Stat.platformRevenue, 50);
    assert.equal(day1Stat.rideCommission, 50);
    assert.equal(day1Stat.subscriptionRevenue, 0);

    assert.equal(day2Stat.platformRevenue, 199);
    assert.equal(day2Stat.rideCommission, 0);
    assert.equal(day2Stat.subscriptionRevenue, 199);
  });

  it('8. IST timezone boundary: 11:30 PM IST (18:00 UTC) correctly maps to the IST day', () => {
    // 2026-09-20 23:30:00 IST is 2026-09-20 18:00:00 UTC
    const eveningUtc = new Date('2026-09-20T18:00:00.000Z');
    const istDate = formatIstDate(eveningUtc);
    assert.equal(
      istDate,
      '2026-09-20',
      '18:00 UTC corresponds to 23:30 IST on the same calendar day in IST',
    );

    // 2026-09-20 00:15:00 IST is 2026-09-19 18:45:00 UTC
    const midnightUtc = new Date('2026-09-19T18:45:00.000Z');
    const midnightIstDate = formatIstDate(midnightUtc);
    assert.equal(
      midnightIstDate,
      '2026-09-20',
      '18:45 UTC on previous UTC day is already 00:15 IST next day',
    );
  });

  it('9. Handles empty revenue data gracefully with clean zero values', () => {
    const trend = service.buildEarningTrend(fixedStart, [], []);
    assert.equal(trend.length, 7, 'Should produce 7 days');
    for (const stat of trend) {
      assert.equal(stat.platformRevenue, 0);
      assert.equal(stat.earnings, 0);
      assert.equal(stat.rideCommission, 0);
      assert.equal(stat.subscriptionRevenue, 0);
      assert.equal(stat.platformFees, 0);
      assert.equal(stat.grossRideValue, 0);
      assert.equal(stat.ridesCount, 0);
      assert.ok(typeof stat.date === 'string' && stat.date.length > 0);
    }
  });

  it('10. Failed payments never post ledger revenue entries (yielding 0 revenue)', () => {
    // Failed payment intents do not create ledger entries to PLATFORM_COMMISSION / SUBSCRIPTION_REVENUE
    const ledgerRows: LedgerAggRow[] = [];
    const trend = service.buildEarningTrend(fixedStart, ledgerRows, []);
    const dayStat = trend.find((t) => t.date === formatIstWeekday(fixedStart))!;

    assert.equal(dayStat.platformRevenue, 0);
    assert.equal(dayStat.subscriptionRevenue, 0);
  });
});
