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

  private async providersForCapability(
    capability: MapCapability,
    pinnedProvider?: MapProviderName,
  ): Promise<{ primary: MapProvider; fallbacks: MapProvider[]; policy: CachedMapSettings }> {
    const policy = await this.resolvePolicy();
    const primary = pinnedProvider
      ? this.buildProvider(pinnedProvider, policy)
      : ((await this.resolveProviderChain())[0] ?? null);
    if (!primary) {
      throw new RoutingProviderUnavailableError();
    }

    const fallbacks: MapProvider[] = [];
    if (policy.fallbackEnabled) {
      const chain = policy.fallbackByCapability[capability] ?? [];
      for (const name of chain) {
        if (!policy.enabledProviders.includes(name)) continue;
        const fb = this.buildProvider(name, policy);
        if (fb) fallbacks.push(fb);
      }
    }

    return { primary, fallbacks, policy };
  }

  private buildMeta(
    provider: MapProvider,
    policy: CachedMapSettings,
    capability: MapCapability,
    usedFallback: boolean,
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
      usedFallback,
      attribution: attr,
      provenance: `${provider.providerName}_${capability}`,
    };
  }

  private classifyProviderError(err: unknown): never {
    if (err instanceof MapProviderAuthError || err instanceof MapProviderQuotaError) throw err;
    if (err instanceof MapProviderTimeoutError) throw err;
    if (err instanceof RoutingProviderUnavailableError) throw err;
    throw new RoutingProviderUnavailableError();
  }

  private async withFallback<T extends { providerName: string }>(
    capability: MapCapability,
    pinnedProvider: MapProviderName | undefined,
    invoke: (provider: MapProvider) => Promise<T>,
  ): Promise<T> {
    const { primary, fallbacks, policy } = await this.providersForCapability(
      capability,
      pinnedProvider,
    );
    const candidates = [primary, ...fallbacks];

    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      try {
        const result = await invoke(provider);
        const meta = this.buildMeta(provider, policy, capability, i > 0);
        return attachMeta(result, meta);
      } catch (err) {
        lastErr = err;
        logger.warn(
          { provider: provider.providerName, capability, err },
          '[MapProviderService] provider call failed',
        );
      }
    }

    this.classifyProviderError(lastErr);
  }

  async getDirections(
    origin: Coordinate,
    destination: Coordinate,
    pinnedProvider?: MapProviderName,
  ): Promise<RoutingResult> {
    return this.withFallback('route', pinnedProvider, (provider) =>
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
    return this.withFallback('route_matrix', pinnedProvider, (provider) =>
      provider.getDistanceMatrix(origins, destinations),
    );
  }

  async autocomplete(
    input: string,
    location?: Coordinate,
    pinnedProvider?: MapProviderName,
  ): Promise<AutocompleteResult> {
    try {
      return await this.withFallback('autocomplete', pinnedProvider, (provider) =>
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
    return this.withFallback('reverse_geocode', pinnedProvider, (provider) =>
      provider.reverseGeocode(coordinate),
    );
  }

  async forwardGeocode(
    address: string,
    pinnedProvider?: MapProviderName,
  ): Promise<ForwardGeocodeResult> {
    return this.withFallback('geocode', pinnedProvider, async (provider) => {
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
    return attachMeta(result, this.buildMeta(provider, policy, 'place_details', false));
  }
}
