import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  haversineKm,
  haversineMeters,
  isValidCoordinate,
  isValidLatitude,
  isValidLongitude,
  normalizeCoordinate,
} from '../../../src/modules/location/utils/coordinate.util.js';
import { CoordinateService } from '../../../src/modules/location/core-services/coordinate.service.js';
import {
  InvalidCoordinateError,
  InvalidSearchRadiusError,
} from '../../../src/modules/location/errors/location.errors.js';
import { geoConfig } from '../../../src/config/geo/geo.config.js';

const DELHI = { latitude: 28.6139, longitude: 77.209 };
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

describe('geo coordinate validation', () => {
  it('accepts latitudes inside the range', () => {
    assert.equal(isValidLatitude(0), true);
    assert.equal(isValidLatitude(28.6139), true);
    assert.equal(isValidLatitude(-33.8688), true);
  });

  it('accepts the latitude boundaries exactly', () => {
    assert.equal(isValidLatitude(90), true);
    assert.equal(isValidLatitude(-90), true);
  });

  it('rejects latitudes past the poles', () => {
    assert.equal(isValidLatitude(90.0001), false);
    assert.equal(isValidLatitude(-90.0001), false);
    assert.equal(isValidLatitude(1000), false);
  });

  it('accepts the longitude boundaries exactly', () => {
    assert.equal(isValidLongitude(180), true);
    assert.equal(isValidLongitude(-180), true);
  });

  it('rejects longitudes past the antimeridian', () => {
    assert.equal(isValidLongitude(180.0001), false);
    assert.equal(isValidLongitude(-180.0001), false);
  });

  it('rejects non-finite and non-numeric values', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, '28.6', {}]) {
      assert.equal(isValidLatitude(bad), false, `latitude ${String(bad)} should be invalid`);
      assert.equal(isValidLongitude(bad), false, `longitude ${String(bad)} should be invalid`);
    }
  });

  it('requires both halves to be valid', () => {
    assert.equal(isValidCoordinate(28.6139, 77.209), true);
    assert.equal(isValidCoordinate(28.6139, 200), false);
    assert.equal(isValidCoordinate(200, 77.209), false);
  });

  it('normalizes to the precision the database column stores', () => {
    const normalized = normalizeCoordinate({
      latitude: 28.61391234567891,
      longitude: 77.20901234567891,
    });
    assert.equal(normalized.latitude, 28.6139123);
    assert.equal(normalized.longitude, 77.2090123);
  });
});

describe('geo haversine', () => {
  it('is zero for identical points', () => {
    assert.equal(haversineKm(DELHI.latitude, DELHI.longitude, DELHI.latitude, DELHI.longitude), 0);
  });

  it('measures a known intercity distance', () => {
    const km = haversineKm(DELHI.latitude, DELHI.longitude, MUMBAI.latitude, MUMBAI.longitude);
    assert.ok(km > 1100 && km < 1200, `expected ~1150km, got ${km}`);
  });

  it('is symmetric', () => {
    const there = haversineKm(DELHI.latitude, DELHI.longitude, MUMBAI.latitude, MUMBAI.longitude);
    const back = haversineKm(MUMBAI.latitude, MUMBAI.longitude, DELHI.latitude, DELHI.longitude);
    assert.ok(Math.abs(there - back) < 1e-9);
  });

  it('reports metres as a thousand times kilometres', () => {
    const km = haversineKm(DELHI.latitude, DELHI.longitude, MUMBAI.latitude, MUMBAI.longitude);
    const m = haversineMeters(DELHI.latitude, DELHI.longitude, MUMBAI.latitude, MUMBAI.longitude);
    assert.ok(Math.abs(m - km * 1000) < 1e-6);
  });
});

describe('CoordinateService', () => {
  const service = new CoordinateService();

  it('returns the coordinate when valid', () => {
    assert.deepEqual(service.assertValid(28.6139, 77.209), DELHI);
  });

  it('throws rather than returning a flag for a bad latitude', () => {
    assert.throws(() => service.assertValid(91, 77.209), InvalidCoordinateError);
  });

  it('throws for a bad longitude', () => {
    assert.throws(() => service.assertValid(28.6139, 181), InvalidCoordinateError);
  });

  it('accepts a radius inside the configured ceiling', () => {
    assert.equal(service.assertRadius(3000), 3000);
  });

  it('refuses a radius over the ceiling', () => {
    assert.throws(
      () => service.assertRadius(geoConfig.maxSearchRadiusMeters + 1),
      InvalidSearchRadiusError,
    );
  });

  it('refuses a zero or negative radius', () => {
    assert.throws(() => service.assertRadius(0), InvalidSearchRadiusError);
    assert.throws(() => service.assertRadius(-5), InvalidSearchRadiusError);
  });
});
