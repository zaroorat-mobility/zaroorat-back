import { asClass, asFunction, AwilixContainer } from 'awilix';
import { GeoMetrics } from './metrics/geo.metrics.js';
import {
  H3Provider,
  PostgisProvider,
  RedisGeoProvider,
  MapplsProvider,
} from './providers/index.js';
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
    mapplsProvider: asFunction(() => {
      const clientId = process.env.MAPPLS_CLIENT_ID;
      const clientSecret = process.env.MAPPLS_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error('MAPPLS_CLIENT_ID and MAPPLS_CLIENT_SECRET must be set');
      }
      return new MapplsProvider({ clientId, clientSecret });
    }).singleton(),
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
