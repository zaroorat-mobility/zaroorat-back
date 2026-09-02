import { geoConfig } from '@config/geo';
import { InvalidCoordinateError, InvalidSearchRadiusError } from '../errors/location.errors.js';
import {
  isValidLatitude,
  isValidLongitude,
  normalizeCoordinate,
} from '../utils/coordinate.util.js';
import type { Coordinate } from '../types/geo.types.js';
export class CoordinateService {
  assertValid(latitude: unknown, longitude: unknown): Coordinate {
    if (!isValidLatitude(latitude)) {
      throw new InvalidCoordinateError(latitude, longitude, 'latitude out of range');
    }
    if (!isValidLongitude(longitude)) {
      throw new InvalidCoordinateError(latitude, longitude, 'longitude out of range');
    }
    return { latitude, longitude };
  }
  normalize(coordinate: Coordinate): Coordinate {
    return normalizeCoordinate(this.assertValid(coordinate.latitude, coordinate.longitude));
  }
  assertRadius(radiusMeters: number): number {
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      throw new InvalidSearchRadiusError(radiusMeters, geoConfig.maxSearchRadiusMeters);
    }
    if (radiusMeters > geoConfig.maxSearchRadiusMeters) {
      throw new InvalidSearchRadiusError(radiusMeters, geoConfig.maxSearchRadiusMeters);
    }
    return radiusMeters;
  }
}
