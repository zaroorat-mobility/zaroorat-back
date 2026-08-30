import { PostgisProvider } from '../providers/postgis.provider.js';
import { CoordinateService } from './coordinate.service.js';
import { haversineKm, haversineMeters } from '../utils/coordinate.util.js';
import type { Coordinate } from '../types/geo.types.js';
export class DistanceService {
  constructor(
    private readonly postgisProvider: PostgisProvider,
    private readonly coordinateService: CoordinateService,
  ) {}
  straightLineKm(from: Coordinate, to: Coordinate): number {
    this.coordinateService.assertValid(from.latitude, from.longitude);
    this.coordinateService.assertValid(to.latitude, to.longitude);
    return haversineKm(from.latitude, from.longitude, to.latitude, to.longitude);
  }
  straightLineMeters(from: Coordinate, to: Coordinate): number {
    this.coordinateService.assertValid(from.latitude, from.longitude);
    this.coordinateService.assertValid(to.latitude, to.longitude);
    return haversineMeters(from.latitude, from.longitude, to.latitude, to.longitude);
  }
  async exactMeters(from: Coordinate, to: Coordinate): Promise<number> {
    return this.postgisProvider.distanceMeters(
      this.coordinateService.assertValid(from.latitude, from.longitude),
      this.coordinateService.assertValid(to.latitude, to.longitude),
    );
  }
}
