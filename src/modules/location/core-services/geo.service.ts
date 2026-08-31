import { CoordinateService } from './coordinate.service.js';
import { DistanceService } from './distance.service.js';
import { NearbyDriverService } from './nearby-driver.service.js';
import type {
  Coordinate,
  DriverPosition,
  NearbyDriversResult,
  NearbySearch,
} from '../types/geo.types.js';
export class GeoService {
  constructor(
    public readonly coordinates: CoordinateService,
    public readonly distance: DistanceService,
    public readonly nearby: NearbyDriverService,
  ) {}
  validateCoordinate(latitude: unknown, longitude: unknown): Coordinate {
    return this.coordinates.assertValid(latitude, longitude);
  }
  findNearbyDrivers(search: NearbySearch): Promise<NearbyDriversResult> {
    return this.nearby.find(search);
  }
  calculateDistanceMeters(from: Coordinate, to: Coordinate): number {
    return this.distance.straightLineMeters(from, to);
  }
  calculateExactDistanceMeters(from: Coordinate, to: Coordinate): Promise<number> {
    return this.distance.exactMeters(from, to);
  }
  recordDriverPosition(position: {
    driverId: string;
    latitude: number;
    longitude: number;
    recordedAt?: Date;
  }): Promise<DriverPosition> {
    return this.nearby.recordPosition(position);
  }
  forgetDriverPosition(driverId: string): Promise<void> {
    return this.nearby.forgetPosition(driverId);
  }
  liveDriverPosition(driverId: string): Promise<DriverPosition | null> {
    return this.nearby.livePosition(driverId);
  }
}
