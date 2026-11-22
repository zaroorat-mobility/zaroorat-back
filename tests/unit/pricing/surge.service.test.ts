import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { PricingMetrics } from '../../../src/modules/pricing/metrics/pricing.metrics.js';
import {
  SurgeService,
  DEFAULT_SURGE_MULTIPLIER,
  MIN_SURGE_MULTIPLIER,
  MAX_SURGE_MULTIPLIER,
} from '../../../src/modules/pricing/services/surge.service.js';
import type { SurgeRepository } from '../../../src/modules/pricing/repositories/surge.repository.js';
import type { FeatureFlagService } from '../../../src/modules/admin/system-settings/platform/services/feature-flag.service.js';
import { Prisma, type SurgeZone, type SurgeWindow } from '../../../src/generated/prisma/index.js';

describe('SurgeService', () => {
  let surgeService: SurgeService;

  let mockActiveZones: SurgeZone[] = [];
  let mockActiveWindows: SurgeWindow[] = [];

  let findWindowsArgs: unknown[] = [];

  const mockSurgeRepo = {
    findActiveZonesForLocation: async (_lat: number, _lng: number) => mockActiveZones,
    // BD-4. `findZonesForLocation` resolves both geographies — the geographic
    // module's service zones and, for one release, the legacy surge polygons.
    // The stub tracks the repository's real surface rather than the subset the
    // service happened to call before.
    findZonesForLocation: async (_lat: number, _lng: number, _cityCode?: string) => ({
      serviceZoneIds: [],
      legacySurgeZoneIds: mockActiveZones.map((zone) => zone.id),
    }),
    findActiveWindowsForZones: async (
      zoneIds: string[],
      serviceZoneIds: string[] = [],
      cityCode?: string,
    ) => {
      findWindowsArgs = [zoneIds, serviceZoneIds, cityCode];
      return mockActiveWindows;
    },
  } as unknown as SurgeRepository;

  let surgeOn: boolean | Error = true;
  const flags = {
    isOn: async () => {
      if (surgeOn instanceof Error) throw surgeOn;
      return surgeOn;
    },
  } as unknown as FeatureFlagService;
  let failures = 0;
  class CountingMetrics extends PricingMetrics {
    override surgeResolutionFailed() {
      failures++;
    }
  }

  beforeEach(() => {
    mockActiveZones = [];
    mockActiveWindows = [];
    findWindowsArgs = [];
    surgeOn = true;
    failures = 0;
    surgeService = new SurgeService(mockSurgeRepo, new CountingMetrics(), flags);
  });

  const baseLat = 12.9716;
  const baseLng = 77.5946;
  const vehicleTypeId = 'v1';

  it('should return DEFAULT_SURGE if no active zones found', async () => {
    mockActiveZones = [];
    const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);
    assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
  });

  it('should return DEFAULT_SURGE if active zones found but no active windows', async () => {
    mockActiveZones = [{ id: 'z1' } as SurgeZone];
    mockActiveWindows = [];

    const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);

    // BD-4. The repository is now asked for both geographies; a point with no
    // service zones passes an empty list alongside the legacy ids.
    assert.deepEqual(findWindowsArgs, [['z1'], [], undefined]);
    assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
  });

  it('should return the highest valid multiplier if multiple windows overlap', async () => {
    mockActiveZones = [{ id: 'z1' }, { id: 'z2' }] as SurgeZone[];
    mockActiveWindows = [
      { multiplier: new Prisma.Decimal(1.2), id: 'w1' } as unknown as SurgeWindow,
      { multiplier: new Prisma.Decimal(1.5), id: 'w2' } as unknown as SurgeWindow,
      { multiplier: new Prisma.Decimal(1.3), id: 'w3' } as unknown as SurgeWindow,
    ];

    const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);

    assert.equal(surge, 1.5);
  });

  it('should cap the surge multiplier to MAX_SURGE_MULTIPLIER', async () => {
    mockActiveZones = [{ id: 'z1' } as SurgeZone];
    mockActiveWindows = [{ multiplier: new Prisma.Decimal(2.5) } as unknown as SurgeWindow];

    const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);

    assert.equal(surge, MAX_SURGE_MULTIPLIER);
  });

  it('should floor the surge multiplier to MIN_SURGE_MULTIPLIER if DB has lower value', async () => {
    mockActiveZones = [{ id: 'z1' } as SurgeZone];
    mockActiveWindows = [{ multiplier: new Prisma.Decimal(0.8) } as unknown as SurgeWindow];

    const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);

    assert.equal(surge, MIN_SURGE_MULTIPLIER);
  });

  describe('the city cap', () => {
    it('limits a window to the legal cap in this city', async () => {
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(2) } as unknown as SurgeWindow];
      const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId, {
        maxMultiplier: 1.5,
      });
      assert.equal(surge, 1.5);
    });

    it('never goes above the platform limit, whatever a city is set to', async () => {
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(2.5) } as unknown as SurgeWindow];
      const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId, {
        maxMultiplier: 3,
      });
      assert.equal(surge, MAX_SURGE_MULTIPLIER);
    });

    it('applies the cap to every vehicle type in a quote', async () => {
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(2) } as unknown as SurgeWindow];
      const surges = await surgeService.resolveSurgeMultipliersForTypes(
        baseLat,
        baseLng,
        ['a', 'b'],
        { maxMultiplier: 1.5 },
      );
      assert.equal(surges.get('a'), 1.5);
      assert.equal(surges.get('b'), 1.5);
    });
  });

  describe('the off-switch', () => {
    it('charges no surge when the flag is off', async () => {
      surgeOn = false;
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(2) } as unknown as SurgeWindow];
      const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);
      assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
    });

    it('charges no surge and counts a failure when the flag cannot be read', async () => {
      surgeOn = new Error('database unavailable');
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(2) } as unknown as SurgeWindow];
      const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId);
      assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
      assert.equal(failures, 1);
    });
  });

  describe('whole-city rules', () => {
    it('asks for city rules even when the point is in no zone', async () => {
      mockActiveZones = [];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(1.5) } as unknown as SurgeWindow];
      const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId, {
        cityCode: 'SGR',
      });
      assert.equal(surge, 1.5);
      assert.deepEqual(findWindowsArgs, [[], [], 'SGR']);
    });

    it('asks for no city rules on global pricing', async () => {
      mockActiveZones = [];
      mockActiveWindows = [{ multiplier: new Prisma.Decimal(1.5) } as unknown as SurgeWindow];
      const surge = await surgeService.resolveSurgeMultiplier(baseLat, baseLng, vehicleTypeId, {
        cityCode: 'GLOBAL',
      });
      assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
      assert.equal(findWindowsArgs.length, 0);
    });
  });

  describe('vehicles', () => {
    const windowFor = (fields: Record<string, unknown>) =>
      ({ multiplier: new Prisma.Decimal(1.5), ...fields }) as unknown as SurgeWindow;

    it('charges each vehicle on a rule that names several, and no other', async () => {
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [windowFor({ vehicleTypeIds: ['cab', 'auto'] })];
      const surges = await surgeService.resolveSurgeMultipliersForTypes(baseLat, baseLng, [
        'cab',
        'auto',
        'bike',
      ]);
      assert.equal(surges.get('cab'), 1.5);
      assert.equal(surges.get('auto'), 1.5);
      assert.equal(surges.get('bike'), DEFAULT_SURGE_MULTIPLIER);
    });

    it('still honours a row that only has the old vehicle column', async () => {
      mockActiveZones = [{ id: 'z1' } as SurgeZone];
      mockActiveWindows = [windowFor({ vehicleTypeIds: [], vehicleTypeId: 'cab' })];
      assert.equal(await surgeService.resolveSurgeMultiplier(baseLat, baseLng, 'cab'), 1.5);
      assert.equal(
        await surgeService.resolveSurgeMultiplier(baseLat, baseLng, 'bike'),
        DEFAULT_SURGE_MULTIPLIER,
      );
    });
  });

  it('should return DEFAULT_SURGE on invalid coordinates', async () => {
    const surge = await surgeService.resolveSurgeMultiplier(NaN, 77.5946, vehicleTypeId);
    assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
    assert.equal(findWindowsArgs.length, 0); // repo not called
  });
});
