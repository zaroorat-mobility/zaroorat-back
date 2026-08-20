import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateHaversineDistanceKm } from '../../../src/modules/rides/utils/distance.util.js';

describe('Haversine Distance Calculator Tests', () => {
  it('calculates 0 km for identical coordinates', () => {
    const distance = calculateHaversineDistanceKm(28.6139, 77.209, 28.6139, 77.209);
    assert.equal(distance, 0);
  });

  it('calculates accurate distance between Delhi and Connaught Place', () => {
    const distance = calculateHaversineDistanceKm(28.6139, 77.209, 28.6315, 77.2167);
    assert.ok(distance > 1.8 && distance < 2.3);
  });
});
