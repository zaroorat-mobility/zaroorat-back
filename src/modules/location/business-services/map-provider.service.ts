import { logger } from '@shared/logger/index.js';
import type { Coordinate } from '../types/geo.types.js';
import type {
  AutocompleteResult,
  ForwardGeocodeResult,
  MapProvider,
  MatrixResult,
  PlaceDetailsResult,
  ReverseGeocodeResult,
  RoutingResult,
} from '../types/map-provider.types.js';
import {
  MapProviderAuthError,
  MapProviderQuotaError,
  MapProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../errors/location.errors.js';
import type { SystemSettingService } from '@modules/admin/system-settings/services/system-setting.service.js';
import type { RedisService } from '@core/cache';
import { OlaMapsProvider } from '../providers/ola-maps.provider.js';
import { GoogleMapsProvider } from '../providers/google-maps.provider.js';
import { MapplsProvider } from '../providers/mappls.provider.js';
import {
  buildMapplsProviderConfig,
  resolveMapCredential,
} from '../../../integrations/mappls/mappls-credentials.util.js';
import { isTimeoutError, ProviderHttpError } from '../../../integrations/provider-http-error.js';
import type { MapCapability, MapResultMeta } from '../types/map-capabilities.types.js';
import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';
import {
  buildMapSettingsFromEnv,
  resolveMapPolicyFromSettings,
  type CachedMapSettings,
} from './map-policy-resolver.js';

export interface MapProviderServiceOptions {
  primaryProvider?: MapProvider;
  providersRegistry?: Record<string, MapProvider>;
  systemSettingService?: SystemSettingService;
  redisService?: RedisService;
}

const CACHE_KEY = 'geo:settings:maps';

function attachMeta<T extends { providerName: string; meta?: MapResultMeta }>(
  result: T,
  meta: MapResultMeta,
): T {
  return { ...result, meta };
}

export class MapProviderService {
  private readonly staticProviders: MapProvider[];
  private readonly registry: Record<string, MapProvider>;
  private readonly systemSettingService?: SystemSettingService | undefined;
  private readonly redisService?: RedisService | undefined;

  constructor(options: MapProviderServiceOptions) {
    const staticList = options.primaryProvider ? [options.primaryProvider] : [];
    this.staticProviders = staticList.filter((p) => p && p.isConfigured());
    this.registry = options.providersRegistry ?? {};
    if (options.primaryProvider) {
      this.registry[options.primaryProvider.providerName] = options.primaryProvider;
    }
    this.systemSettingService = options.systemSettingService;
    this.redisService = options.redisService;
  }

  get activeProviderNames(): string[] {
    return this.staticProviders.map((p) => p.providerName);
  }

  async resolvePolicy(): Promise<CachedMapSettings> {
    const settingService = this.systemSettingService;
    const redis = this.redisService;

    if (!settingService) {
      return buildMapSettingsFromEnv();
    }

    if (redis) {
      try {
        const cachedJson = await redis.provider.client.get(CACHE_KEY);
        if (cachedJson) {
          const cached = JSON.parse(cachedJson) as CachedMapSettings;
          if (cached.primaryProvider) return cached;
          await redis.provider.client.del(CACHE_KEY);
        }
      } catch (err) {
        logger.warn({ err }, '[MapProviderService] Redis map settings cache read failed');
      }
    }

    try {
      const policy = await resolveMapPolicyFromSettings(settingService);
      if (redis) {
        try {
          await redis.provider.client.set(CACHE_KEY, JSON.stringify(policy), 'EX', 3600);
        } catch (err) {
          logger.warn({ err }, '[MapProviderService] Redis map settings cache write failed');
        }
      }
      return policy;
    } catch (err) {
      logger.warn({ err }, '[MapProviderService] Dynamic provider resolution failed');
      return buildMapSettingsFromEnv();
    }
  }

  /// The single active provider, as a one-element list.
  ///
  /// Every capability call resolves its primary through here, so this stays the
  /// one seam that decides which provider serves a request. It was briefly a
  /// parallel path that nothing called, which meant the resilience tests stubbed
  /// it, the real provider ran anyway, and a provider outage that should have
  /// surfaced as a 503 quietly returned a route.
  async resolveProviderChain(): Promise<MapProvider[]> {
    const policy = await this.resolvePolicy();
    const provider = this.buildProvider(policy.primaryProvider, policy);
    return provider ? [provider] : [];
  }

  private buildProvider(name: MapProviderName, policy: CachedMapSettings): MapProvider | null {
    let provider = this.registry[name];
    if (provider?.isConfigured()) return provider;

    if (name === 'ola') {
      const apiKey = resolveMapCredential(
        policy.keys?.olaKey,
        process.env.OLA_MAPS_API_KEY,
        process.env.MAPS_API_KEY,
      );
      if (apiKey) {
        const baseUrl = policy.baseUrls?.olaUrl || process.env.OLA_MAPS_BASE_URL;
        provider = new OlaMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
        this.registry['ola'] = provider;
      }
    } else if (name === 'google') {
      const apiKey = resolveMapCredential(policy.keys?.googleKey, process.env.GOOGLE_MAPS_API_KEY);
      if (apiKey) {
        const baseUrl = policy.baseUrls?.googleUrl || process.env.GOOGLE_MAPS_BASE_URL;
        provider = new GoogleMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
        this.registry['google'] = provider;
      }
    } else if (name === 'mappls') {
      const config = buildMapplsProviderConfig({
        ...(policy.keys?.mapplsRestKey ? { restApiKey: policy.keys.mapplsRestKey } : {}),
        ...(policy.keys?.mapplsId ? { clientId: policy.keys.mapplsId } : {}),
        ...(policy.keys?.mapplsSecret ? { clientSecret: policy.keys.mapplsSecret } : {}),
        ...(policy.baseUrls?.mapplsUrl ? { baseUrl: policy.baseUrls.mapplsUrl } : {}),
      });
      if (config) {
        provider = new MapplsProvider(config);
        this.registry['mappls'] = provider;
      }
    }

    return provider?.isConfigured() ? provider : null;
  }

  private async providerForCapability(
    pinnedProvider?: MapProviderName,
  ): Promise<{ provider: MapProvider; policy: CachedMapSettings }> {
    const policy = await this.resolvePolicy();
    const provider = pinnedProvider
      ? this.buildProvider(pinnedProvider, policy)
      : ((await this.resolveProviderChain())[0] ?? null);
    if (!provider) {
      throw new RoutingProviderUnavailableError();
    }
    return { provider, policy };
  }

  private buildMeta(
    provider: MapProvider,
    policy: CachedMapSettings,
    capability: MapCapability,
  ): MapResultMeta {
    const attr = provider.attribution();
    const generatedAt = new Date();
    const expiresAt = new Date(generatedAt.getTime() + 5 * 60_000);
    return {
      provider: provider.providerName,
      configVersion: policy.configVersion,
      capability,
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      attribution: attr,
      provenance: `${provider.providerName}_${capability}`,
    };
  }

  /// Turn a provider failure into the narrowest error that describes it.
  ///
  /// Everything used to collapse into `RoutingProviderUnavailableError` (503),
  /// so a revoked key, an exhausted quota and a real outage were the same event
  /// to anyone reading logs or dashboards — and `MapProviderAuthError` /
  /// `MapProviderQuotaError` / `MapProviderTimeoutError` were declared but never
  /// thrown. The distinction decides the response: a quota failure is 429 and
  /// worth retrying later, an auth failure is 502 and needs an operator, and only
  /// an unclassifiable failure is a 503.
  private classifyProviderError(err: unknown): never {
    if (err instanceof MapProviderAuthError || err instanceof MapProviderQuotaError) throw err;
    if (err instanceof MapProviderTimeoutError) throw err;
    if (err instanceof RoutingProviderUnavailableError) throw err;

    if (isTimeoutError(err)) {
      throw new MapProviderTimeoutError();
    }

    if (err instanceof ProviderHttpError) {
      if (err.isAuthFailure) {
        throw new MapProviderAuthError(
          `${err.provider} rejected the configured credential (${err.status}). ` +
            'Check the key in Admin → Settings → Maps.',
        );
      }
      if (err.isQuotaFailure) {
        throw new MapProviderQuotaError(`${err.provider} quota or rate limit exceeded (429).`);
      }
    }

    throw new RoutingProviderUnavailableError();
  }

  /// Run one capability call against the single active provider.
  ///
  /// This was `withFallback`, iterating `[primary, ...fallbacks]`. The fallback
  /// list was always empty — see `MapPolicySettings` — so the loop only ever ran
  /// once, while reading like failover the platform did not have. A provider
  /// failure is now classified and raised immediately rather than being swallowed
  /// into a retry against nothing.
  private async withProvider<T extends { providerName: string }>(
    capability: MapCapability,
    pinnedProvider: MapProviderName | undefined,
    invoke: (provider: MapProvider) => Promise<T>,
  ): Promise<T> {
    const { provider, policy } = await this.providerForCapability(pinnedProvider);

    try {
      const result = await invoke(provider);
      return attachMeta(result, this.buildMeta(provider, policy, capability));
    } catch (err) {
      logger.warn(
        { provider: provider.providerName, capability, err },
        '[MapProviderService] provider call failed',
      );
      this.classifyProviderError(err);
    }
  }

  async getDirections(
    origin: Coordinate,
    destination: Coordinate,
    pinnedProvider?: MapProviderName,
  ): Promise<RoutingResult> {
    return this.withProvider('route', pinnedProvider, (provider) =>
      provider.getDirections(origin, destination),
    );
  }

  async getDistanceMatrix(
    origins: Coordinate[],
    destinations: Coordinate[],
    pinnedProvider?: MapProviderName,
  ): Promise<MatrixResult> {
    if (origins.length === 0 || destinations.length === 0) {
      return { status: 'no_drivers', cells: [], providerName: 'none' };
    }

    // A provider outage raises 503 rather than substituting straight-line
    // distances. The degraded branch that used to live here returned a haversine
    // matrix labelled `internal_haversine`; the one internal caller
    // (`RideRequestService`) accepts only `status === 'ok'`, so it was never used
    // for a driver ETA, and on the public route-matrix endpoint it served
    // fabricated distances under a 200.
    return this.withProvider('route_matrix', pinnedProvider, (provider) =>
      provider.getDistanceMatrix(origins, destinations),
    );
  }

  async autocomplete(
    input: string,
    location?: Coordinate,
    pinnedProvider?: MapProviderName,
  ): Promise<AutocompleteResult> {
    try {
      return await this.withProvider('autocomplete', pinnedProvider, (provider) =>
        provider.autocomplete(input, location),
      );
    } catch {
      return { status: 'unavailable', predictions: [], providerName: 'none' };
    }
  }

  async reverseGeocode(
    coordinate: Coordinate,
    pinnedProvider?: MapProviderName,
  ): Promise<ReverseGeocodeResult> {
    return this.withProvider('reverse_geocode', pinnedProvider, (provider) =>
      provider.reverseGeocode(coordinate),
    );
  }

  async forwardGeocode(
    address: string,
    pinnedProvider?: MapProviderName,
  ): Promise<ForwardGeocodeResult> {
    return this.withProvider('geocode', pinnedProvider, async (provider) => {
      if (!provider.forwardGeocode) {
        throw new RoutingProviderUnavailableError('Forward geocoding not supported by provider');
      }
      return provider.forwardGeocode(address);
    });
  }

  async getPlaceDetails(
    placeId: string,
    providerName: MapProviderName,
  ): Promise<PlaceDetailsResult> {
    const policy = await this.resolvePolicy();
    const provider = this.buildProvider(providerName, policy);
    if (!provider?.getPlaceDetails) {
      throw new RoutingProviderUnavailableError('Place details not supported');
    }
    const result = await provider.getPlaceDetails(placeId);
    return attachMeta(result, this.buildMeta(provider, policy, 'place_details'));
  }
}
