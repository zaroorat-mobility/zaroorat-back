import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessPlausibility,
  defaultPlausibilityPolicy,
} from '../../../src/modules/drivers/services/location/location-plausibility.js';
import { haversineKm } from '../../../src/modules/location/utils/coordinate.util.js';
import { driverConfig } from '../../../src/config/driver/driver.config.js';
import { geoConfig } from '../../../src/config/geo/geo.config.js';

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

describe('Driver location plausibility — stale baseline handling', () => {
  // Fixed server clock so every elapsed interval below is exact.
  const NOW = new Date('2026-10-09T04:00:00.000Z');
  const secondsBefore = (s: number) => new Date(NOW.getTime() - s * 1000);
  const PUNE = { latitude: 18.5308, longitude: 73.8475 };
  // Android emulator's default fix after a cold boot (Google HQ, Mountain View).
  const EMULATOR_DEFAULT = { latitude: 37.4219983, longitude: -122.084 };
  const SRINAGAR = { latitude: 34.0837, longitude: 74.7973 };
  const policy = defaultPlausibilityPolicy();

  it('reproduces the incident: a 12.5h-old Pune fix no longer locks out the new position', () => {
    const verdict = assessPlausibility(
      { ...EMULATOR_DEFAULT, accuracyMeters: 5 },
      { ...PUNE, recordedAt: secondsBefore(45_000) },
      NOW,
      policy,
    );
    assert.equal(verdict.plausible, true);
    assert.ok(verdict.plausible && verdict.baselineReset, 'reported as a baseline reset');
    assert.equal(verdict.plausible && verdict.baselineReset?.distanceKm, 13573.55);
    assert.equal(verdict.plausible && verdict.baselineReset?.elapsedSeconds, 45_000);
  });

  it('still rejects the same jump when the previous fix is recent', () => {
    const verdict = assessPlausibility(
      { ...EMULATOR_DEFAULT, accuracyMeters: 5 },
      { ...PUNE, recordedAt: secondsBefore(30) },
      NOW,
      policy,
    );
    assert.equal(verdict.plausible, false);
    assert.equal(verdict.plausible === false && verdict.reason, 'impossible_speed');
    assert.equal(verdict.plausible === false && verdict.facts?.elapsedSeconds, 30);
    assert.ok(verdict.plausible === false && (verdict.facts?.impliedKmh ?? 0) > policy.maxSpeedKmh);
  });

  it('accepts normal movement against a recent fix without calling it a reset', () => {
    const verdict = assessPlausibility(
      { latitude: PUNE.latitude + 0.005, longitude: PUNE.longitude },
      { ...PUNE, recordedAt: secondsBefore(30) },
      NOW,
      policy,
    );
    assert.deepEqual(verdict, { plausible: true });
  });

  it('accepts a legitimate long-distance relocation after a stale gap as a reset', () => {
    // Pune → Srinagar (~1,750km) two hours later: a flight, not a drive.
    const verdict = assessPlausibility(
      { ...SRINAGAR, accuracyMeters: 10 },
      { ...PUNE, recordedAt: secondsBefore(2 * 3600) },
      NOW,
      policy,
    );
    assert.equal(verdict.plausible, true);
    assert.ok(verdict.plausible && verdict.baselineReset);
  });

  it('does not report plausible movement after a stale gap as a reset', () => {
    // ~30km in an hour is ordinary driving even though the fix is stale.
    const verdict = assessPlausibility(
      { latitude: PUNE.latitude + 0.27, longitude: PUNE.longitude },
      { ...PUNE, recordedAt: secondsBefore(3600) },
      NOW,
      policy,
    );
    assert.deepEqual(verdict, { plausible: true });
  });

  it('applies the speed check up to and including the stale threshold', () => {
    const atLimit = assessPlausibility(
      EMULATOR_DEFAULT,
      { ...PUNE, recordedAt: secondsBefore(policy.staleBaselineSeconds) },
      NOW,
      policy,
    );
    assert.equal(atLimit.plausible === false && atLimit.reason, 'impossible_speed');

    const pastLimit = assessPlausibility(
      EMULATOR_DEFAULT,
      { ...PUNE, recordedAt: secondsBefore(policy.staleBaselineSeconds + 1) },
      NOW,
      policy,
    );
    assert.ok(pastLimit.plausible && pastLimit.baselineReset);
  });

  it('refuses to re-baseline a stale location from a poor-accuracy fix', () => {
    const previous = { ...PUNE, recordedAt: secondsBefore(45_000) };
    const poor = assessPlausibility(
      { ...EMULATOR_DEFAULT, accuracyMeters: policy.resetMaxAccuracyMeters + 1 },
      previous,
      NOW,
      policy,
    );
    assert.equal(poor.plausible === false && poor.reason, 'poor_accuracy');

    const atLimit = assessPlausibility(
      { ...EMULATOR_DEFAULT, accuracyMeters: policy.resetMaxAccuracyMeters },
      previous,
      NOW,
      policy,
    );
    assert.ok(atLimit.plausible && atLimit.baselineReset);
  });

  it('does not let accuracy block ordinary movement from a recent fix', () => {
    const verdict = assessPlausibility(
      { latitude: PUNE.latitude + 0.005, longitude: PUNE.longitude, accuracyMeters: 500 },
      { ...PUNE, recordedAt: secondsBefore(30) },
      NOW,
      policy,
    );
    assert.deepEqual(verdict, { plausible: true });
  });

  it('measures a fix without a client timestamp at server receipt time', () => {
    const verdict = assessPlausibility(
      { latitude: PUNE.latitude + 1, longitude: PUNE.longitude },
      { ...PUNE, recordedAt: secondsBefore(10) },
      NOW,
      policy,
    );
    assert.equal(verdict.plausible === false && verdict.reason, 'impossible_speed');
  });

  it('never lets a client timestamp stretch the elapsed time', () => {
    // A timestamp inside the future tolerance is accepted as fresh, but the
    // interval is still measured on the server clock: 10s, not 10s + 100s.
    const verdict = assessPlausibility(
      {
        latitude: PUNE.latitude + 1,
        longitude: PUNE.longitude,
        recordedAt: new Date(NOW.getTime() + 100_000),
      },
      { ...PUNE, recordedAt: secondsBefore(10) },
      NOW,
      policy,
    );
    assert.equal(verdict.plausible === false && verdict.reason, 'impossible_speed');
    assert.equal(verdict.plausible === false && verdict.facts?.elapsedSeconds, 10);
  });

  it('rejects an invalid client timestamp', () => {
    const verdict = assessPlausibility({ ...PUNE, recordedAt: new Date('not a date') }, null, NOW);
    assert.equal(verdict.plausible === false && verdict.reason, 'invalid_timestamp');
  });

  it('rejects a client timestamp beyond the future tolerance', () => {
    const verdict = assessPlausibility(
      { ...PUNE, recordedAt: new Date(NOW.getTime() + (policy.maxAgeSeconds + 1) * 1000) },
      null,
      NOW,
      policy,
    );
    assert.equal(verdict.plausible === false && verdict.reason, 'future_timestamp');
  });

  it('treats no elapsed time as impossible for real movement (no out-of-order bypass)', () => {
    const verdict = assessPlausibility(
      { latitude: PUNE.latitude + 1, longitude: PUNE.longitude },
      { ...PUNE, recordedAt: new Date(NOW.getTime() + 30_000) },
      NOW,
      policy,
    );
    assert.equal(verdict.plausible === false && verdict.reason, 'impossible_speed');
    assert.equal(verdict.plausible === false && verdict.facts?.impliedKmh, null);
  });

  it('treats a baseline stamped far in the future as unusable and replaces it', () => {
    const verdict = assessPlausibility(
      { ...EMULATOR_DEFAULT, accuracyMeters: 5 },
      { ...PUNE, recordedAt: new Date(NOW.getTime() + (policy.staleBaselineSeconds + 60) * 1000) },
      NOW,
      policy,
    );
    assert.ok(verdict.plausible && verdict.baselineReset);
  });

  it('rejects the (0, 0) null fix', () => {
    const verdict = assessPlausibility({ latitude: 0, longitude: 0 }, null, NOW);
    assert.equal(verdict.plausible === false && verdict.reason, 'out_of_range');
  });

  it('defaults the stale window to the live-location TTL and never below dispatch staleness', () => {
    assert.ok(driverConfig.locationStaleBaselineSeconds >= geoConfig.candidateStalenessSeconds);
    if (process.env.DRIVER_LOCATION_STALE_BASELINE_SEC === undefined) {
      assert.equal(driverConfig.locationStaleBaselineSeconds, geoConfig.liveLocationTtlSeconds);
    }
  });
});
