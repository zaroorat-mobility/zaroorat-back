import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { H3Provider } from '../../../src/modules/location/providers/h3.provider.js';
import { InvalidH3CellError } from '../../../src/modules/location/errors/location.errors.js';
import { haversineMeters } from '../../../src/modules/location/utils/coordinate.util.js';
import { geoConfig } from '../../../src/config/geo/geo.config.js';

const BENGALURU = { latitude: 12.9716, longitude: 77.5946 };

describe('H3Provider', () => {
  const h3 = new H3Provider();

  it('uses the configured resolution', () => {
    assert.equal(h3.resolution, geoConfig.h3Resolution);
  });

  it('maps a coordinate to a valid cell', () => {
    const cell = h3.cellFor(BENGALURU);
    assert.equal(h3.isValid(cell), true);
  });

  it('is deterministic — the same coordinate always yields the same cell', () => {
    assert.equal(h3.cellFor(BENGALURU), h3.cellFor(BENGALURU));
  });

  it('puts two points metres apart in the same cell', () => {
    const nudged = { latitude: BENGALURU.latitude + 0.0001, longitude: BENGALURU.longitude };
    assert.equal(h3.cellFor(nudged), h3.cellFor(BENGALURU));
  });

  it('puts distant points in different cells', () => {
    const faraway = { latitude: 28.6139, longitude: 77.209 };
    assert.notEqual(h3.cellFor(faraway), h3.cellFor(BENGALURU));
  });

  it('honours an explicit resolution override', () => {
    assert.notEqual(h3.cellFor(BENGALURU, 5), h3.cellFor(BENGALURU, 9));
  });

  it('returns the seven cells of a one-ring disk', () => {
    const cells = h3.neighbours(h3.cellFor(BENGALURU), 1);
    assert.equal(cells.length, 7);
    assert.ok(cells.includes(h3.cellFor(BENGALURU)));
  });

  it('returns only the origin for a zero ring', () => {
    const origin = h3.cellFor(BENGALURU);
    assert.deepEqual(h3.neighbours(origin, 0), [origin]);
  });

  it('rejects a malformed cell instead of returning nonsense', () => {
    assert.throws(() => h3.neighbours('not-a-cell'), InvalidH3CellError);
    assert.throws(() => h3.centerOf('not-a-cell'), InvalidH3CellError);
  });

  it('recovers a centre inside the cell it came from', () => {
    const cell = h3.cellFor(BENGALURU);
    const centre = h3.centerOf(cell);
    assert.equal(h3.cellFor(centre), cell);
  });

  it('scales rings with the requested radius', () => {
    assert.ok(h3.ringsForRadius(10_000) > h3.ringsForRadius(1_000));
    assert.ok(h3.ringsForRadius(1) >= 1);
  });

  it('covers the search radius — every point in range falls in a returned cell', () => {
    const radiusMeters = 2000;
    const covering = new Set(h3.cellsCovering(BENGALURU, radiusMeters));

    // Sample the rim just inside the radius in eight directions.
    const degPerMetreLat = 1 / 111_320;
    for (let bearing = 0; bearing < 360; bearing += 45) {
      const rad = (bearing * Math.PI) / 180;
      const reach = radiusMeters * 0.95;
      const point = {
        latitude: BENGALURU.latitude + Math.cos(rad) * reach * degPerMetreLat,
        longitude:
          BENGALURU.longitude +
          (Math.sin(rad) * reach * degPerMetreLat) / Math.cos((BENGALURU.latitude * Math.PI) / 180),
      };

      assert.ok(
        haversineMeters(BENGALURU.latitude, BENGALURU.longitude, point.latitude, point.longitude) <=
          radiusMeters,
        'sample point should be inside the radius',
      );
      assert.ok(
        covering.has(h3.cellFor(point)),
        `bearing ${bearing}° at ${reach}m fell outside the covering cells`,
      );
    }
  });
});
