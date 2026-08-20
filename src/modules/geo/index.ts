import { asClass, AwilixContainer } from 'awilix';
import { GeoMetrics } from './metrics/geo.metrics.js';
import { H3Provider, PostgisProvider, RedisGeoProvider } from './providers/index.js';
import {
  CoordinateService,
  DistanceService,
  NearbyDriverService,
  GeoService,
} from './services/index.js';
export * from './providers/index.js';
export * from './services/index.js';
export * from './schemas/index.js';
export * from './metrics/index.js';
export * from './errors/index.js';
export * from './constants/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export function registerGeoModule(container: AwilixContainer): void {
  container.register({
    geoMetrics: asClass(GeoMetrics).singleton(),
    h3Provider: asClass(H3Provider).singleton(),
    postgisProvider: asClass(PostgisProvider).singleton(),
    redisGeoProvider: asClass(RedisGeoProvider).singleton(),
    coordinateService: asClass(CoordinateService).singleton(),
    distanceService: asClass(DistanceService).singleton(),
    nearbyDriverService: asClass(NearbyDriverService).singleton(),
    geoService: asClass(GeoService)
      .singleton()
      .inject((c) => ({
        coordinates: c.resolve('coordinateService'),
        distance: c.resolve('distanceService'),
        nearby: c.resolve('nearbyDriverService'),
      })),
  });
}
