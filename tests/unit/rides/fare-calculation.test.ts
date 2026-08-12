import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FareService } from '../../../src/modules/rides/services/fare/fare.service.js';

const fareService = new FareService();

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

  it('prices vehicle types differently when a rate card is configured', async () => {
    const card = fareService.rateCardFor('v-type-1');
    const premium = { ...card, perKm: card.perKm * 2, baseFare: card.baseFare * 2 };

    const original = fareService.rateCardFor;
    (fareService as unknown as { rateCardFor: (id: string) => unknown }).rateCardFor = (
      id: string,
    ) => (id === 'premium' ? premium : card);

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
      (fareService as unknown as { rateCardFor: unknown }).rateCardFor = original;
    }
  });

  it('never bills below the minimum fare', async () => {
    const result = await fareService.calculateFinalFare({
      actualDistanceKm: 0,
      actualDurationMin: 0,
      vehicleTypeId: 'v-type-1',
    });
    assert.ok(result.totalFare >= fareService.rateCardFor('v-type-1').minimumFare);
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
