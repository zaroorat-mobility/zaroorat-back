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
      const clientId = process.env.MAPPLS_CLIENT_ID ?? '';
      const clientSecret = process.env.MAPPLS_CLIENT_SECRET ?? '';
      const baseUrl = process.env.MAPPLS_BASE_URL;
      return new MapplsProvider({ clientId, clientSecret, ...(baseUrl ? { baseUrl } : {}) });
    }).singleton(),

    // Unified Composite Map Provider Service (Handles Primary + Fallback chain)
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
        const fallbackNames = (process.env.MAP_PROVIDER_FALLBACK ?? 'google,mappls')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);

        const providerMap: Record<string, MapProvider> = {
          ola: olaMapsProvider,
          google: googleMapsProvider,
          mappls: mapplsProvider,
        };

        const primaryProvider = (providerMap[primaryName] ?? providerMap['ola'])!;
        const fallbackProviders = fallbackNames
          .map((name) => providerMap[name])
          .filter((p): p is MapProvider =>
            Boolean(p && p.providerName !== primaryProvider.providerName),
          );

        return new MapProviderService({
          primaryProvider,
          fallbackProviders,
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
