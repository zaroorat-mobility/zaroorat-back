import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArrivalDetectionService } from '../../../src/modules/rides/services/arrival/arrival-detection.service.js';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { LifecycleService } from '../../../src/modules/rides/services/lifecycle/lifecycle.service.js';
import type { RedisService } from '../../../src/core/cache/RedisService.js';

describe('Arrival Detection Service Tests', () => {
  const pickupLat = 28.6139;
  const pickupLng = 77.209;
  const dropLat = 28.5355;
  const dropLng = 77.391;

  interface MockRideRecord {
    id: string;
    driverId: string;
    status: string;
    request?: {
      pickupLat?: number;
      pickupLng?: number;
      dropLat?: number;
      dropLng?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  function createFixture(initialRide: MockRideRecord | null = null) {
    const memory = new Map<string, string>();
    let activeRide = initialRide;
    let markArrivedCalls = 0;
    let markDropoffCalls = 0;

    const mockRedisClient = {
      incr: async (key: string) => {
        const val = Number(memory.get(key) ?? '0') + 1;
        memory.set(key, String(val));
        return val;
      },
      expire: async () => 1,
      del: async (key: string) => {
        memory.delete(key);
        return 1;
      },
      set: async (key: string, val: string, ...args: (string | number)[]) => {
        if (args.includes('NX')) {
          if (memory.has(key)) return null;
          memory.set(key, val);
          return 'OK';
        }
        memory.set(key, val);
        return 'OK';
      },
      get: async (key: string) => memory.get(key) ?? null,
    };

    const mockRedisService = {
      provider: {
        client: mockRedisClient,
      },
    } as unknown as RedisService;

    const mockRideRepo = {
      findActiveByDriver: async () => activeRide,
    } as unknown as RideRepository;

    const mockLifecycle = {
      markDriverArrived: async () => {
        markArrivedCalls++;
        if (activeRide) activeRide.status = 'DRIVER_ARRIVED';
        return activeRide;
      },
      markDriverArrivedAtDropoff: async () => {
        markDropoffCalls++;
        if (activeRide) activeRide.status = 'DRIVER_AT_DROPOFF';
        return activeRide;
      },
    } as unknown as LifecycleService;

    const service = new ArrivalDetectionService(mockRideRepo, mockLifecycle, mockRedisService);

    return {
      service,
      memory,
      getActiveRide: () => activeRide,
      setActiveRide: (r: MockRideRecord | null) => {
        activeRide = r;
      },
      getMarkArrivedCalls: () => markArrivedCalls,
      getMarkDropoffCalls: () => markDropoffCalls,
    };
  }

  it('rejects mock location fixes without evaluating or storing', async () => {
    const { service } = createFixture();
    const res = await service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 10,
      isMockLocation: true,
    });
    assert.equal(res.evaluated, false);
    assert.equal(res.reason, 'MOCK_LOCATION');
  });

  it('rejects missing or invalid accuracy fixes', async () => {
    const { service } = createFixture();
    const res1 = await service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: null,
    });
    assert.equal(res1.evaluated, false);
    assert.equal(res1.reason, 'MISSING_ACCURACY');

    const res2 = await service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: NaN,
    });
    assert.equal(res2.evaluated, false);
    assert.equal(res2.reason, 'MISSING_ACCURACY');
  });

  it('poor accuracy does nothing', async () => {
    const { service } = createFixture();
    const res = await service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 80, // Default max allowed is 50
    });
    assert.equal(res.evaluated, false);
    assert.equal(res.reason, 'LOW_ACCURACY');
  });

  it('rejects stale fixes', async () => {
    const { service } = createFixture();
    const now = Date.now();
    const res = await service.evaluateFix(
      {
        driverId: 'd-1',
        latitude: pickupLat,
        longitude: pickupLng,
        accuracyMeters: 10,
        recordedAt: new Date(now - 45000), // 45s old, max age 30s
      },
      now,
    );
    assert.equal(res.evaluated, false);
    assert.equal(res.reason, 'STALE_FIX');
  });

  it('one valid fix inside radius does not transition', async () => {
    const fixture = createFixture({
      id: 'ride-1',
      driverId: 'd-1',
      status: 'ACCEPTED',
      request: { pickupLat, pickupLng, dropLat, dropLng },
    });

    const res = await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 10,
    });

    assert.equal(res.evaluated, true);
    assert.equal(res.target, 'pickup');
    assert.equal(res.consecutiveFixes, 1);
    assert.equal(res.transitioned, false);
    assert.equal(fixture.getMarkArrivedCalls(), 0);
  });

  it('GPS jump out of radius resets confirmation counter', async () => {
    const fixture = createFixture({
      id: 'ride-1',
      driverId: 'd-1',
      status: 'ACCEPTED',
      request: { pickupLat, pickupLng, dropLat, dropLng },
    });

    // Fix 1 & 2 inside radius
    await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 10,
    });
    const res2 = await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 10,
    });
    assert.equal(res2.consecutiveFixes, 2);

    // Fix 3 jumps 500m away (GPS jump / out-of-radius)
    const res3 = await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat + 0.005,
      longitude: pickupLng + 0.005,
      accuracyMeters: 10,
    });

    assert.equal(res3.consecutiveFixes, 0);
    assert.equal(res3.transitioned, false);
    assert.equal(res3.reason, 'OUT_OF_RADIUS');
    assert.equal(fixture.getMarkArrivedCalls(), 0);
  });

  it('3 valid pickup fixes mark arrived', async () => {
    const fixture = createFixture({
      id: 'ride-1',
      driverId: 'd-1',
      status: 'DRIVER_ARRIVING',
      request: { pickupLat, pickupLng, dropLat, dropLng },
    });

    await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 10,
    });
    await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 15,
    });
    const res3 = await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: pickupLat,
      longitude: pickupLng,
      accuracyMeters: 12,
    });

    assert.equal(res3.evaluated, true);
    assert.equal(res3.target, 'pickup');
    assert.equal(res3.consecutiveFixes, 3);
    assert.equal(res3.transitioned, true);
    assert.equal(fixture.getMarkArrivedCalls(), 1);
  });

  it('3 valid drop fixes mark drop-off arrived', async () => {
    const fixture = createFixture({
      id: 'ride-2',
      driverId: 'd-1',
      status: 'IN_PROGRESS',
      request: { pickupLat, pickupLng, dropLat, dropLng },
    });

    await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: dropLat,
      longitude: dropLng,
      accuracyMeters: 10,
    });
    await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: dropLat,
      longitude: dropLng,
      accuracyMeters: 10,
    });
    const res3 = await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: dropLat,
      longitude: dropLng,
      accuracyMeters: 10,
    });

    assert.equal(res3.evaluated, true);
    assert.equal(res3.target, 'drop');
    assert.equal(res3.consecutiveFixes, 3);
    assert.equal(res3.transitioned, true);
    assert.equal(fixture.getMarkDropoffCalls(), 1);
  });

  it('duplicate fixes and concurrent events remain idempotent under lock', async () => {
    const fixture = createFixture({
      id: 'ride-3',
      driverId: 'd-1',
      status: 'IN_PROGRESS',
      request: { pickupLat, pickupLng, dropLat, dropLng },
    });

    // Preset Redis count to 2 fixes
    fixture.memory.set('ride:arrival:fixes:ride-3:drop', '2');
    // Simulate lock already acquired by another concurrent thread
    fixture.memory.set('ride:arrival:lock:ride-3:drop', '1');

    const res = await fixture.service.evaluateFix({
      driverId: 'd-1',
      latitude: dropLat,
      longitude: dropLng,
      accuracyMeters: 10,
    });

    assert.equal(res.evaluated, true);
    assert.equal(res.consecutiveFixes, 3);
    assert.equal(res.transitioned, false);
    assert.equal(res.reason, 'LOCKED');
    assert.equal(fixture.getMarkDropoffCalls(), 0);
  });
});
