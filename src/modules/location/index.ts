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
import { MapsController } from './controllers/maps.controller.js';
import { RideLocationHistoryService } from './services/ride-location-history.service.js';
import { RideEtaService } from './services/ride-eta.service.js';
import type { MapProvider } from './types/map-provider.types.js';
import { buildMapplsProviderConfig } from '../../integrations/mappls/mappls-credentials.util.js';

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
      const config = buildMapplsProviderConfig({
        restApiKey: process.env.MAPPLS_REST_API_KEY ?? '',
        clientId: process.env.MAPPLS_CLIENT_ID ?? '',
        clientSecret: process.env.MAPPLS_CLIENT_SECRET ?? '',
        ...(process.env.MAPPLS_BASE_URL ? { baseUrl: process.env.MAPPLS_BASE_URL } : {}),
      }) ?? { restApiKey: '' };
      return new MapplsProvider(config);
    }).singleton(),

    // Unified map provider service — exactly one active provider (no fallback chain)
    //
    // The parameters must stay positional and named exactly as registered:
    // the container runs in `InjectionMode.CLASSIC`, which injects by reading the
    // factory's parameter names. A destructured `({ a, b }) => ...` parameter is
    // named `{ a, b }`, matches no registration, and silently yields `undefined`
    // for every dependency.
    mapProviderService: asFunction(
      function mapProviderServiceFactory(
        olaMapsProvider,
        googleMapsProvider,
        mapplsProvider,
        systemSettingService,
        redisService,
      ) {
        const providerMap: Record<string, MapProvider> = {
          ola: olaMapsProvider,
          google: googleMapsProvider,
          mappls: mapplsProvider,
        };

        const envPrimary = (process.env.MAP_PROVIDER ?? 'ola').trim().toLowerCase();
        const primaryProvider: MapProvider =
          (providerMap[envPrimary]?.isConfigured() ? providerMap[envPrimary] : undefined) ??
          Object.values(providerMap).find((p) => p.isConfigured()) ??
          providerMap[envPrimary] ??
          providerMap.ola ??
          olaMapsProvider;

        return new MapProviderService({
          primaryProvider,
          providersRegistry: providerMap,
          systemSettingService,
          redisService,
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
    rideLocationHistoryService: asClass(RideLocationHistoryService).singleton(),
    rideEtaService: asClass(RideEtaService).singleton(),
    mapsController: asClass(MapsController).singleton(),
  });
}
