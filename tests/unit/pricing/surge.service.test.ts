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
      vehicleTypeId?: string,
      serviceZoneIds: string[] = [],
    ) => {
      findWindowsArgs = [zoneIds, vehicleTypeId, serviceZoneIds];
      return mockActiveWindows;
    },
  } as unknown as SurgeRepository;

  beforeEach(() => {
    mockActiveZones = [];
    mockActiveWindows = [];
    findWindowsArgs = [];
    surgeService = new SurgeService(mockSurgeRepo, new PricingMetrics());
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
    assert.deepEqual(findWindowsArgs, [['z1'], vehicleTypeId, []]);
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

  it('should return DEFAULT_SURGE on invalid coordinates', async () => {
    const surge = await surgeService.resolveSurgeMultiplier(NaN, 77.5946, vehicleTypeId);
    assert.equal(surge, DEFAULT_SURGE_MULTIPLIER);
    assert.equal(findWindowsArgs.length, 0); // repo not called
  });
});
