// Must be the first import: it sets the trip-estimation env before `@config`
// freezes `pricingConfig`. See the file for why it cannot be an assignment at
// the top of this one.
import './../helpers/trip-estimate-env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pricingConfig } from '../../../src/config/pricing/pricing.config.js';
import { PricingService } from '../../../src/modules/pricing';
import { calculateHaversineDistanceKm } from '../../../src/modules/pricing/utils/distance.util.js';

const pricingService = new PricingService({} as never);

const PICKUP = { latitude: 12.9716, longitude: 77.5946 };
/// Roughly 1km north — far enough to survive the zero-distance guard, small
/// enough that the arithmetic stays readable.
const DROP = { latitude: 12.9806, longitude: 77.5946 };

function estimate() {
  return pricingService.estimateTrip({
    pickupLat: PICKUP.latitude,
    pickupLng: PICKUP.longitude,
    dropLat: DROP.latitude,
    dropLng: DROP.longitude,
  });
}

/// The road factor and the assumed speed scale every quoted distance and every
/// quoted duration on the platform, and they were the only pricing inputs an
/// operator could not touch — literals inside `estimateTrip` while everything
/// else came from `pricingConfig`.
describe('trip estimation reads its constants from config (L-3)', () => {
  it('is running on overridden values, not the code defaults', () => {
    // Guards the rest of this file: at the defaults 1.3 and 3 the assertions
    // below would pass against the old literals too and prove nothing.
    assert.equal(pricingConfig.roadDistanceFactor, 2);
    assert.equal(pricingConfig.minutesPerKm, 6);
  });

  it('scales the straight line by the configured road factor', () => {
    const straightLineKm = calculateHaversineDistanceKm(
      PICKUP.latitude,
      PICKUP.longitude,
      DROP.latitude,
      DROP.longitude,
    );
    const expected = Math.round(straightLineKm * pricingConfig.roadDistanceFactor * 100) / 100;

    assert.equal(estimate().distanceKm, expected);
    assert.notEqual(
      estimate().distanceKm,
      Math.round(straightLineKm * 1.3 * 100) / 100,
      'the hardcoded 1.3 is back',
    );
  });

  it('derives the duration from the configured minutes per kilometre', () => {
    const { distanceKm, durationMin } = estimate();
    assert.equal(durationMin, Math.round(distanceKm * pricingConfig.minutesPerKm));
    assert.notEqual(durationMin, Math.round(distanceKm * 3), 'the hardcoded 3 is back');
  });

  it('still never quotes a trip as taking no time at all', () => {
    // A very short but non-zero journey rounds its duration to zero minutes;
    // the floor of one is what stops the time component vanishing.
    const shortTrip = pricingService.estimateTrip({
      pickupLat: PICKUP.latitude,
      pickupLng: PICKUP.longitude,
      dropLat: PICKUP.latitude + 0.0001,
      dropLng: PICKUP.longitude,
    });
    assert.ok(shortTrip.durationMin >= 1);
  });
});
