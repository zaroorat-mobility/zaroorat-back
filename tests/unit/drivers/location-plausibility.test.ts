import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessPlausibility,
  haversineKm,
} from '../../../src/modules/drivers/services/location/location-plausibility.js';
import { driverConfig } from '../../../src/config/driver/driver.config.js';

const DELHI = { latitude: 28.6139, longitude: 77.209 };

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

describe('Driver location plausibility (server-side, not client-asserted)', () => {
  it('measures a known distance correctly', () => {
    const km = haversineKm(28.6139, 77.209, 19.076, 72.8777);
    assert.ok(km > 1100 && km < 1200, `expected ~1150km, got ${km}`);
  });

  it('accepts a first fix with no history', () => {
    assert.deepEqual(assessPlausibility(DELHI, null), { plausible: true });
  });

  it('accepts normal road movement', () => {
    const previous = { ...DELHI, recordedAt: minutesAgo(10) };

    const verdict = assessPlausibility({ latitude: 28.6589, longitude: 77.209 }, previous);
    assert.equal(verdict.plausible, true);
  });

  it('rejects a teleport across the country', () => {
    const previous = { ...DELHI, recordedAt: minutesAgo(1) };
    const verdict = assessPlausibility({ latitude: 19.076, longitude: 72.8777 }, previous);

    assert.equal(verdict.plausible, false);
    assert.equal(verdict.plausible === false && verdict.reason, 'impossible_speed');
  });

  it('rejects coordinates outside the valid range', () => {
    for (const bad of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: Number.NaN, longitude: 0 },
    ]) {
      const verdict = assessPlausibility(bad, null);
      assert.equal(verdict.plausible, false);
      assert.equal(verdict.plausible === false && verdict.reason, 'out_of_range');
    }
  });

  it('rejects a stale fix', () => {
    const verdict = assessPlausibility(
      {
        ...DELHI,
        recordedAt: new Date(Date.now() - (driverConfig.locationMaxAgeSeconds + 60) * 1000),
      },
      null,
    );
    assert.equal(verdict.plausible, false);
    assert.equal(verdict.plausible === false && verdict.reason, 'stale');
  });

  it('treats GPS jitter on a stationary driver as movement-free', () => {
    const previous = { ...DELHI, recordedAt: new Date(Date.now() - 1000) };
    const jittered = { latitude: DELHI.latitude + 0.0001, longitude: DELHI.longitude + 0.0001 };

    assert.ok(
      haversineKm(DELHI.latitude, DELHI.longitude, jittered.latitude, jittered.longitude) * 1000 <
        driverConfig.locationNoiseFloorMeters,
    );
    assert.equal(assessPlausibility(jittered, previous).plausible, true);
  });

  it('accepts an out-of-order fix rather than dividing by a negative interval', () => {
    const previous = { ...DELHI, recordedAt: new Date(Date.now() + 60_000) };
    assert.equal(assessPlausibility(DELHI, previous).plausible, true);
  });
});
