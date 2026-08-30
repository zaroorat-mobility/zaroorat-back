import { asClass, asFunction, AwilixContainer } from 'awilix';
import { GeoMetrics, GeographicMetrics } from './metrics/location.metrics.js';
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
} from './core-services/index.js';
import { GeographicCoverageService } from './business-services/index.js';

// Public API — all consumers import from '@modules/location'
export * from './providers/index.js';
export * from './core-services/index.js';
export * from './business-services/index.js';
export * from './schemas/index.js';
export * from './metrics/index.js';
export * from './errors/index.js';
export * from './constants/index.js';
export * from './types/index.js';
export * from './utils/index.js';

/// Single registration function that replaces registerGeoModule +
/// registerGeographicModule — DI names are identical to before so no
/// consumer code needs to change beyond the import path in di.ts.
export function registerLocationModule(container: AwilixContainer): void {
  container.register({
    // Metrics
    geoMetrics: asClass(GeoMetrics).singleton(),
    geographicMetrics: asClass(GeographicMetrics).singleton(),

    // Providers
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

    // Core services
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

    // Business services
    geographicCoverageService: asClass(GeographicCoverageService).singleton(),
  });
}
