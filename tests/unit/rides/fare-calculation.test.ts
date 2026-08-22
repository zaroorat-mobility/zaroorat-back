import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FareService } from '../../../src/modules/rides/services/fare/fare.service.js';
import type { VehicleTypeRepository } from '../../../src/modules/vehicles/repositories/vehicle-type.repository.js';
import type { VehicleType } from '../../../src/modules/vehicles/types/index.js';

/// Pricing now comes from the VehicleType row. These cases exercise the pricing
/// arithmetic, not the lookup, so the repository is stubbed: 'v-type-1' has no
/// pricing columns set and therefore prices on the platform defaults, exactly
/// as it did when rate cards lived in configuration.
function vehicleType(overrides: Partial<VehicleType> = {}): VehicleType {
  return {
    id: 'v-type-1',
    code: 'CAB',
    name: 'Cab',
    icon: null,
    displayOrder: 0,
    passengerCapacity: 4,
    luggageCapacity: 2,
    minimumFare: null,
    baseFare: null,
    perKmRate: null,
    perMinuteRate: null,
    waitingCharge: null,
    cancellationCharge: null,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  } as VehicleType;
}

const types = new Map<string, VehicleType>([['v-type-1', vehicleType()]]);

const vehicleTypeRepository = {
  findById: async (id: string) => types.get(id) ?? null,
} as unknown as VehicleTypeRepository;

const fareService = new FareService(vehicleTypeRepository);

describe('Itemized fare calculation', () => {
  it('computes an itemized quote whose parts reconcile to the total', async () => {
    const result = await fareService.calculateFareQuote({
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
        fareService.calculateFareQuote({
          pickupLat: 28.6139,
          pickupLng: 77.209,
          vehicleTypeId: 'v-type-1',
        }),
      /drop coordinates/i,
    );
  });
});

describe('Final fare (billed on actual trip values)', () => {
  it('charges a 40 km ride more than a 2 km ride', async () => {
    const short = await fareService.calculateFinalFare({
      actualDistanceKm: 2,
      actualDurationMin: 8,
      vehicleTypeId: 'v-type-1',
    });
    const long = await fareService.calculateFinalFare({
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
    const result = await fareService.calculateFinalFare({
      actualDistanceKm: 12.5,
      actualDurationMin: 30,
      vehicleTypeId: 'v-type-1',
    });
    assert.equal(result.estimatedDistanceKm, 12.5);
    assert.equal(result.estimatedDurationMin, 30);
  });

  it('prices vehicle types differently from their own pricing columns', async () => {
    const card = fareService.rateCardFor(vehicleType());
    types.set(
      'premium',
      vehicleType({
        id: 'premium',
        code: 'CAB_PREMIUM',
        perKmRate: (card.perKm * 2) as unknown as VehicleType['perKmRate'],
        baseFare: (card.baseFare * 2) as unknown as VehicleType['baseFare'],
      }),
    );

    try {
      const standard = await fareService.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId: 'v-type-1',
      });
      const expensive = await fareService.calculateFinalFare({
        actualDistanceKm: 10,
        actualDurationMin: 20,
        vehicleTypeId: 'premium',
      });
      assert.ok(expensive.totalFare > standard.totalFare);
    } finally {
      types.delete('premium');
    }
  });

  it('falls back per field, so a type that prices only per-km keeps sane defaults', () => {
    const fallback = fareService.rateCardFor(null);
    const partial = fareService.rateCardFor(
      vehicleType({ perKmRate: 99 as unknown as VehicleType['perKmRate'] }),
    );

    assert.equal(partial.perKm, 99);
    assert.equal(partial.baseFare, fallback.baseFare);
    assert.equal(partial.minimumFare, fallback.minimumFare);
    assert.equal(partial.commissionRate, fallback.commissionRate);
  });

  it('prices an unknown vehicle type on the platform default rather than throwing', async () => {
    const result = await fareService.calculateFinalFare({
      actualDistanceKm: 10,
      actualDurationMin: 20,
      vehicleTypeId: 'does-not-exist',
    });
    assert.ok(result.totalFare > 0);
  });

  it('never bills below the minimum fare', async () => {
    const result = await fareService.calculateFinalFare({
      actualDistanceKm: 0,
      actualDurationMin: 0,
      vehicleTypeId: 'v-type-1',
    });
    assert.ok(result.totalFare >= fareService.rateCardFor(vehicleType()).minimumFare);
  });

  it('rejects negative or non-finite trip values rather than pricing them', async () => {
    await assert.rejects(
      () =>
        fareService.calculateFinalFare({
          actualDistanceKm: -5,
          actualDurationMin: 10,
          vehicleTypeId: 'v-type-1',
        }),
      /actualDistanceKm/,
    );
    await assert.rejects(
      () =>
        fareService.calculateFinalFare({
          actualDistanceKm: Number.NaN,
          actualDurationMin: 10,
          vehicleTypeId: 'v-type-1',
        }),
      /actualDistanceKm/,
    );
  });

  it('keeps money to two decimal places', async () => {
    const result = await fareService.calculateFinalFare({
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
