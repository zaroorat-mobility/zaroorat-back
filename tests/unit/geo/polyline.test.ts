import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInterpolatedPath,
  decodeEncodedPolyline,
  encodeCoordinatesToPolyline,
} from '../../../src/shared/geo/polyline.util.js';

describe('polyline encoding and decoding', () => {
  it('round-trips coordinates through encode and decode', () => {
    const coords = [
      { latitude: 28.6139, longitude: 77.209 },
      { latitude: 28.5355, longitude: 77.391 },
    ];

    const encoded = encodeCoordinatesToPolyline(coords);
    assert.ok(typeof encoded === 'string' && encoded.length > 0);

    const decoded = decodeEncodedPolyline(encoded);
    assert.equal(decoded.length, coords.length);
    assert.ok(Math.abs(decoded[0]!.latitude - coords[0]!.latitude) < 1e-4);
    assert.ok(Math.abs(decoded[0]!.longitude - coords[0]!.longitude) < 1e-4);
    assert.ok(Math.abs(decoded[1]!.latitude - coords[1]!.latitude) < 1e-4);
    assert.ok(Math.abs(decoded[1]!.longitude - coords[1]!.longitude) < 1e-4);
  });

  it('encodes interpolated paths reliably', () => {
    const origin = { latitude: 28.6139, longitude: 77.209 };
    const destination = { latitude: 28.5355, longitude: 77.391 };
    const path = buildInterpolatedPath(origin, destination, 4);

    const encoded = encodeCoordinatesToPolyline(path);
    assert.ok(encoded.length > 0);

    const decoded = decodeEncodedPolyline(encoded);
    assert.equal(decoded.length, path.length);
  });
});
