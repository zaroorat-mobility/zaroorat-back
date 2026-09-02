import { asClass, asFunction, AwilixContainer } from 'awilix';
import { GeoMetrics, GeographicMetrics } from './metrics/location.metrics.js';
import {
  H3Provider,
  PostgisProvider,
  RedisGeoProvider,
  OlaMapsProvider,
  GoogleMapsProvider,
  MapplsProvider,
} from './providers/index.js';
import {
  CoordinateService,
  DistanceService,
  NearbyDriverService,
  GeoService,
} from './core-services/index.js';
import { GeographicCoverageService, MapProviderService } from './business-services/index.js';
import type { MapProvider } from './types/map-provider.types.js';
import type { SystemSettingService } from '../admin/system-settings/index.js';
import type { RedisService } from '../../core/cache/index.js';

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

export function registerLocationModule(container: AwilixContainer): void {
  container.register({
    // Metrics
    geoMetrics: asClass(GeoMetrics).singleton(),
    geographicMetrics: asClass(GeographicMetrics).singleton(),

    // Infrastructure & Datastore Providers
    h3Provider: asClass(H3Provider).singleton(),
    postgisProvider: asClass(PostgisProvider).singleton(),
    redisGeoProvider: asClass(RedisGeoProvider).singleton(),

    // External Map Providers
    olaMapsProvider: asFunction(() => {
      const apiKey = process.env.OLA_MAPS_API_KEY ?? process.env.MAPS_API_KEY ?? '';
      const baseUrl = process.env.OLA_MAPS_BASE_URL;
      return new OlaMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    }).singleton(),

    googleMapsProvider: asFunction(() => {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
      const baseUrl = process.env.GOOGLE_MAPS_BASE_URL;
      return new GoogleMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    }).singleton(),

    mapplsProvider: asFunction(() => {
      const restApiKey = process.env.MAPPLS_REST_API_KEY ?? '';
      const clientId = process.env.MAPPLS_CLIENT_ID ?? '';
      const clientSecret = process.env.MAPPLS_CLIENT_SECRET ?? '';
      const baseUrl = process.env.MAPPLS_BASE_URL;
      const config =
        clientId && clientSecret
          ? {
              clientId,
              clientSecret,
              ...(restApiKey ? { restApiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            }
          : restApiKey || clientId
            ? { restApiKey: restApiKey || clientId, ...(baseUrl ? { baseUrl } : {}) }
            : { restApiKey: '' };
      return new MapplsProvider(config);
    }).singleton(),

    // Unified map provider service — exactly one active provider (no fallback chain)
    mapProviderService: asFunction(
      ({
        olaMapsProvider,
        googleMapsProvider,
        mapplsProvider,
        systemSettingService,
        redisService,
      }: {
        olaMapsProvider: OlaMapsProvider;
        googleMapsProvider: GoogleMapsProvider;
        mapplsProvider: MapplsProvider;
        systemSettingService?: SystemSettingService;
        redisService?: RedisService;
      }) => {
        const primaryName = (process.env.MAP_PROVIDER ?? 'ola').trim().toLowerCase();

        const providerMap: Record<string, MapProvider> = {
          ola: olaMapsProvider,
          google: googleMapsProvider,
          mappls: mapplsProvider,
        };

        const primaryProvider = (providerMap[primaryName] ?? providerMap['ola'])!;

        return new MapProviderService({
          primaryProvider,
          providersRegistry: providerMap,
          ...(systemSettingService ? { systemSettingService } : {}),
          ...(redisService ? { redisService } : {}),
        });
      },
    ).singleton(),

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
