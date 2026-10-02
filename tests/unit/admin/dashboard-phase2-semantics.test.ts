import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calculateFinancials,
  calculatePercentageChange,
} from '../../../src/modules/admin/dashboard/financial.calculator.js';
import { comparisonWindows } from '../../../src/modules/admin/dashboard/dashboard.periods.js';
import {
  aggregateHealth,
  probeGps,
  probeNotifications,
  probePaymentFailures,
  summarizeGps,
  summarizeNotifications,
  summarizePaymentTransactions,
  type HealthStatuses,
} from '../../../src/modules/admin/dashboard/dashboard.health.js';
import { classifyVehicleMode } from '../../../src/modules/admin/dashboard/dashboard.service.js';
import {
  activityQuerySchema,
  financialAnalyticsQuerySchema,
  liveDriversQuerySchema,
  parseActivityCursor,
} from '../../../src/modules/admin/dashboard/dashboard.schemas.js';

const fail = () => Promise.reject(new Error('query failed'));

describe('Dashboard Phase 2: KPI comparisons', () => {
  it('current > previous', () => assert.equal(calculatePercentageChange(15, 10), 50));
  it('current < previous', () => assert.equal(calculatePercentageChange(5, 10), -50));
  it('equal', () => assert.equal(calculatePercentageChange(10, 10), 0));
  it('previous = 0 has no percentage', () => assert.equal(calculatePercentageChange(7, 0), null));
  it('both = 0 has no percentage', () => assert.equal(calculatePercentageChange(0, 0), null));
  it('current = 0 is a real -100 %', () => assert.equal(calculatePercentageChange(0, 4), -100));
});

describe('Dashboard Phase 2: IST comparison windows', () => {
  it('partial day: yesterday is compared up to the same IST time of day', () => {
    // 14:00 IST on 2026-09-29 = 08:30 UTC
    const w = comparisonWindows(new Date('2026-09-29T08:30:00.000Z'));
    assert.equal(w.todayStart.toISOString(), '2026-09-28T18:30:00.000Z'); // 00:00 IST
    assert.equal(w.yesterdayStart.toISOString(), '2026-09-27T18:30:00.000Z');
    assert.equal(w.sameTimeYesterday.toISOString(), '2026-09-28T08:30:00.000Z'); // 14:00 IST yesterday
    assert.equal(w.tomorrowStart.toISOString(), '2026-09-29T18:30:00.000Z');
    // Both windows have the same elapsed length
    assert.equal(
      w.now.getTime() - w.todayStart.getTime(),
      w.sameTimeYesterday.getTime() - w.yesterdayStart.getTime(),
    );
  });

  it('just after IST midnight the windows are one minute long and on the right days', () => {
    // 00:01 IST on 2026-09-29 = 18:31 UTC on 2026-09-28
    const w = comparisonWindows(new Date('2026-09-28T18:31:00.000Z'));
    assert.equal(w.todayStart.toISOString(), '2026-09-28T18:30:00.000Z');
    assert.equal(w.sameTimeYesterday.toISOString(), '2026-09-27T18:31:00.000Z');
    assert.equal(w.sameTimeYesterday.getTime() - w.yesterdayStart.getTime(), 60_000);
  });

  it('just before IST midnight still belongs to the same IST day', () => {
    // 23:59 IST on 2026-09-28 = 18:29 UTC on 2026-09-28
    const w = comparisonWindows(new Date('2026-09-28T18:29:00.000Z'));
    assert.equal(w.todayStart.toISOString(), '2026-09-27T18:30:00.000Z');
  });
});

describe('Dashboard Phase 2: financial signs are preserved', () => {
  it('a commission that exceeds the fare yields negative driver collections', () => {
    const r = calculateFinancials({
      grossRideValue: 80,
      rideCommission: 100,
      platformFees: 10,
      subscriptionRevenue: 0,
    });
    assert.equal(r.driverRideCollections, -30);
    assert.equal(r.rideDeductions, 110);
  });

  it('a promo-funded commission DEBIT and a subscription refund can make revenue negative', () => {
    const r = calculateFinancials({
      grossRideValue: 500,
      rideCommission: -40,
      platformFees: 0,
      subscriptionRevenue: -199,
    });
    assert.equal(r.platformRevenue, -239);
    assert.equal(
      r.driverRideCollections,
      540,
      'a negative commission leaves the driver more than the fare',
    );
  });

  it('subscription revenue is never deducted from driver collections', () => {
    const r = calculateFinancials({
      grossRideValue: 1000,
      rideCommission: 100,
      platformFees: 20,
      subscriptionRevenue: 199,
    });
    assert.equal(r.driverRideCollections, 880);
    assert.equal(r.platformRevenue, 319);
  });
});

describe('Dashboard Phase 2: notification health', () => {
  it('zero deliveries is NO_DATA, not 100 % HEALTHY', () => {
    assert.deepEqual(summarizeNotifications([]), {
      notificationSuccessRate: null,
      notificationStatus: 'NO_DATA',
    });
  });
  it('all successful', () => {
    assert.deepEqual(
      summarizeNotifications([
        { status: 'DELIVERED', count: 4 },
        { status: 'SENT', count: 6 },
      ]),
      {
        notificationSuccessRate: 100,
        notificationStatus: 'HEALTHY',
      },
    );
  });
  it('some failed (below 90 % is DEGRADED)', () => {
    assert.deepEqual(
      summarizeNotifications([
        { status: 'SENT', count: 8 },
        { status: 'FAILED', count: 2 },
      ]),
      {
        notificationSuccessRate: 80,
        notificationStatus: 'DEGRADED',
      },
    );
  });
  it('PENDING only is still in flight: NO_DATA', () => {
    assert.equal(
      summarizeNotifications([{ status: 'PENDING', count: 9 }]).notificationStatus,
      'NO_DATA',
    );
  });
  it('QUEUED only is still in flight: NO_DATA', () => {
    assert.equal(
      summarizeNotifications([{ status: 'QUEUED', count: 9 }]).notificationStatus,
      'NO_DATA',
    );
  });
  it('READ counts as a success', () => {
    assert.deepEqual(summarizeNotifications([{ status: 'READ', count: 3 }]), {
      notificationSuccessRate: 100,
      notificationStatus: 'HEALTHY',
    });
  });
  it('mixed states: in-flight rows neither help nor hurt', () => {
    const r = summarizeNotifications([
      { status: 'DELIVERED', count: 9 },
      { status: 'READ', count: 9 },
      { status: 'FAILED', count: 2 },
      { status: 'PENDING', count: 50 },
      { status: 'QUEUED', count: 50 },
    ]);
    assert.deepEqual(r, { notificationSuccessRate: 90, notificationStatus: 'HEALTHY' });
  });
  it('query failure is UNAVAILABLE with no rate', async () => {
    assert.deepEqual(await probeNotifications(fail), {
      notificationSuccessRate: null,
      notificationStatus: 'UNAVAILABLE',
    });
  });
});

describe('Dashboard Phase 2: online payment failure rate', () => {
  it('no settled payments is NO_DATA, not 0 % HEALTHY', () => {
    assert.deepEqual(summarizePaymentTransactions([{ status: 'PENDING', count: 3 }]), {
      paymentFailureRate24h: null,
      paymentFailureStatus: 'NO_DATA',
    });
  });
  it('CANCELLED (payer abandoned) is excluded from the rate', () => {
    assert.deepEqual(
      summarizePaymentTransactions([
        { status: 'SUCCEEDED', count: 19 },
        { status: 'FAILED', count: 1 },
        { status: 'CANCELLED', count: 80 },
      ]),
      { paymentFailureRate24h: 5, paymentFailureStatus: 'HEALTHY' },
    );
  });
  it('WARNING above 5 % and CRITICAL above 10 %', () => {
    assert.equal(
      summarizePaymentTransactions([
        { status: 'SUCCEEDED', count: 93 },
        { status: 'FAILED', count: 7 },
      ]).paymentFailureStatus,
      'WARNING',
    );
    assert.equal(
      summarizePaymentTransactions([
        { status: 'SUCCEEDED', count: 8 },
        { status: 'FAILED', count: 2 },
      ]).paymentFailureStatus,
      'CRITICAL',
    );
  });
  it('query failure is UNAVAILABLE, not HEALTHY (no fail-open)', async () => {
    assert.deepEqual(await probePaymentFailures(fail), {
      paymentFailureRate24h: null,
      paymentFailureStatus: 'UNAVAILABLE',
    });
  });
});

describe('Dashboard Phase 2: GPS freshness health', () => {
  const now = new Date('2026-09-29T08:30:00.000Z');
  const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

  it('nobody on duty is NO_DATA', () => {
    assert.deepEqual(
      summarizeGps({ onDutyDrivers: 0, latestRecordedAt: secondsAgo(9999) }, now, 120),
      {
        gpsFreshnessSec: null,
        gpsFreshnessStatus: 'NO_DATA',
      },
    );
  });
  it('drivers on duty but no fix at all is STALE', () => {
    assert.deepEqual(summarizeGps({ onDutyDrivers: 3, latestRecordedAt: null }, now, 120), {
      gpsFreshnessSec: null,
      gpsFreshnessStatus: 'STALE',
    });
  });
  it('fix within the threshold (inclusive) is LIVE', () => {
    assert.deepEqual(
      summarizeGps({ onDutyDrivers: 3, latestRecordedAt: secondsAgo(120) }, now, 120),
      {
        gpsFreshnessSec: 120,
        gpsFreshnessStatus: 'LIVE',
      },
    );
  });
  it('fix older than the threshold is STALE with the real age', () => {
    assert.deepEqual(
      summarizeGps({ onDutyDrivers: 3, latestRecordedAt: secondsAgo(121) }, now, 120),
      {
        gpsFreshnessSec: 121,
        gpsFreshnessStatus: 'STALE',
      },
    );
  });
  it('query failure is UNAVAILABLE', async () => {
    assert.deepEqual(await probeGps(fail, now, 120), {
      gpsFreshnessSec: null,
      gpsFreshnessStatus: 'UNAVAILABLE',
    });
  });
});

describe('Dashboard Phase 2: overall health aggregation', () => {
  const healthy: HealthStatuses = {
    databaseStatus: 'HEALTHY',
    redisStatus: 'HEALTHY',
    websocketStatus: 'HEALTHY',
    notificationStatus: 'HEALTHY',
    gpsFreshnessStatus: 'LIVE',
    paymentFailureStatus: 'HEALTHY',
  };

  it('all healthy', () => assert.equal(aggregateHealth(healthy), 'HEALTHY'));
  it('NO_DATA and DISABLED do not degrade', () =>
    assert.equal(
      aggregateHealth({
        ...healthy,
        websocketStatus: 'DISABLED',
        notificationStatus: 'NO_DATA',
        gpsFreshnessStatus: 'NO_DATA',
        paymentFailureStatus: 'NO_DATA',
      }),
      'HEALTHY',
    ));
  it('Redis DOWN is CRITICAL', () =>
    assert.equal(aggregateHealth({ ...healthy, redisStatus: 'DOWN' }), 'CRITICAL'));
  it('database DOWN is CRITICAL', () =>
    assert.equal(aggregateHealth({ ...healthy, databaseStatus: 'DOWN' }), 'CRITICAL'));
  it('critical payment failure rate is CRITICAL', () =>
    assert.equal(aggregateHealth({ ...healthy, paymentFailureStatus: 'CRITICAL' }), 'CRITICAL'));
  it('WebSocket DOWN is DEGRADED', () =>
    assert.equal(aggregateHealth({ ...healthy, websocketStatus: 'DOWN' }), 'DEGRADED'));
  it('GPS STALE is DEGRADED', () =>
    assert.equal(aggregateHealth({ ...healthy, gpsFreshnessStatus: 'STALE' }), 'DEGRADED'));
  it('an unmeasurable probe is DEGRADED, never HEALTHY', () =>
    assert.equal(aggregateHealth({ ...healthy, notificationStatus: 'UNAVAILABLE' }), 'DEGRADED'));
});

describe('Dashboard Phase 2: vehicle mode', () => {
  it('classifies from the vehicle type name or code', () => {
    assert.equal(classifyVehicleMode('Auto Rickshaw', 'AUTO'), 'Auto');
    assert.equal(classifyVehicleMode('Bike Taxi', 'TWO_WHEELER'), 'Bike');
    assert.equal(classifyVehicleMode('Economy', 'SCOOTER_STD'), 'Bike');
    assert.equal(classifyVehicleMode('Economy', 'CAB_ECONOMY'), 'Car');
  });
});

describe('Dashboard Phase 2: input validation', () => {
  const rejects = (
    schema: { safeParse: (v: unknown) => { success: boolean } },
    query: Record<string, string>,
  ) => assert.equal(schema.safeParse(query).success, false, JSON.stringify(query));

  it('financial analytics range', () => {
    assert.equal(financialAnalyticsQuerySchema.parse({}).range, '7d');
    rejects(financialAnalyticsQuerySchema, { range: '1year' });
  });

  it('live-drivers limit, status, mode and viewport', () => {
    assert.equal(liveDriversQuerySchema.parse({}).limit, 50);
    assert.equal(liveDriversQuerySchema.parse({ limit: '200' }).limit, 200);
    for (const limit of ['0', '201', 'abc', '1.5']) rejects(liveDriversQuerySchema, { limit });
    rejects(liveDriversQuerySchema, { status: 'SLEEPING' });
    rejects(liveDriversQuerySchema, { mode: 'Truck' });
    for (const viewport of ['1,2,3', '1,,2,3', 'a,b,c,d', '91,0,92,1', '10,20,5,30', '1,2,3,4,5']) {
      rejects(liveDriversQuerySchema, { viewport });
    }
    assert.equal(
      liveDriversQuerySchema.parse({ viewport: '12.9,77.5,13.0,77.6' }).viewport,
      '12.9,77.5,13.0,77.6',
    );
  });

  it('activity limit, type and cursor', () => {
    assert.equal(activityQuerySchema.parse({}).limit, 20);
    for (const limit of ['0', '101', 'x']) rejects(activityQuerySchema, { limit });
    rejects(activityQuerySchema, { type: 'EVERYTHING' });
    for (const cursor of [
      '2026-09-29T06:00:00.000Z',
      '2026-09-29T06:00:00.000Z|ride:not-a-uuid',
      '2026-09-29T06:00:00.000Z|payment:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      '2026-13-45T06:00:00.000Z|ride:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    ]) {
      rejects(activityQuerySchema, { cursor });
    }
    const cursor = '2026-09-29T06:00:00.000Z|kyc:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    assert.equal(activityQuerySchema.parse({ cursor }).cursor, cursor);
    assert.deepEqual(parseActivityCursor(cursor), {
      at: new Date('2026-09-29T06:00:00.000Z'),
      source: 'kyc',
      rawId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    });
  });
});
