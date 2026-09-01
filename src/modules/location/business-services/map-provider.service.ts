import { logger } from '@shared/logger/index.js';
import type { Coordinate } from '../types/geo.types.js';
import type {
  AutocompleteResult,
  MapProvider,
  MatrixResult,
  ReverseGeocodeResult,
  RoutingResult,
} from '../types/map-provider.types.js';
import { RoutingProviderUnavailableError } from '../errors/location.errors.js';
import type { SystemSettingService } from '@modules/admin/system-settings/index.js';
import type { RedisService } from '@core/cache';
import { OlaMapsProvider } from '../providers/ola-maps.provider.js';
import { GoogleMapsProvider } from '../providers/google-maps.provider.js';
import { MapplsProvider } from '../providers/mappls.provider.js';
import {
  buildMapplsProviderConfig,
  resolveMapCredential,
} from '../../../integrations/mappls/mappls-credentials.util.js';

export interface MapProviderServiceOptions {
  primaryProvider?: MapProvider;
  providersRegistry?: Record<string, MapProvider>;
  systemSettingService?: SystemSettingService;
  redisService?: RedisService;
}

interface CachedMapSettings {
  primaryProvider: string;
  keys?: Record<string, string>;
  baseUrls?: Record<string, string>;
}

/**
 * Single Active MapProviderService — Resolves exactly ONE active map provider.
 *
 * Strict single-active-provider architecture:
 * 1. Checks Redis settings cache ('geo:settings:maps').
 * 2. If miss, queries Database SystemSetting records ('maps' category).
 * 3. Resolves exactly ONE active provider for routing, geocoding, and distance matrix.
 * 4. If the active provider fails, raises controlled error (HTTP 503) without calling secondary providers.
 */
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

  /// Both arrive through the constructor. `registerLocationModule` resolves them
  /// from the container explicitly rather than through a destructured parameter,
  /// which `InjectionMode.CLASSIC` cannot read — see the note there.
  ///
  /// These used to fall back to `container.resolve(...)`. That import of the DI
  /// root closed a cycle (location barrel -> here -> @core/di -> module
  /// registration -> location barrel, still half-evaluated) which left 9 unit
  /// test files unable to load at all.
  private getSettingService(): SystemSettingService | undefined {
    return this.systemSettingService;
  }

  private getRedis(): RedisService | undefined {
    return this.redisService;
  }

  /**
   * Resolves the single active map provider for the application.
   */
  async resolveProviderChain(): Promise<MapProvider[]> {
    const settingService = this.getSettingService();
    const redis = this.getRedis();

    if (!settingService) {
      logger.warn(
        '[MapProviderService] SystemSettingService unavailable — using env credentials only',
      );
      const envChain = this.buildProviderChainFromEnv();
      if (envChain.length > 0) return envChain;
      return this.fallbackStaticChain();
    }

    // 1. Check Redis cache (isolated — a cache outage must not skip DB resolution)
    if (redis) {
      try {
        const cachedJson = await redis.provider.client.get('geo:settings:maps');
        if (cachedJson) {
          const cached = JSON.parse(cachedJson) as CachedMapSettings;
          const chain = this.buildProviderChain(
            cached.primaryProvider,
            cached.keys,
            cached.baseUrls,
          );
          if (chain.length > 0) return chain;
          try {
            await redis.provider.client.del('geo:settings:maps');
          } catch {
            // ignore cache delete failures
          }
        }
      } catch (err) {
        logger.warn({ err }, '[MapProviderService] Redis map settings cache read failed');
      }
    }

    // 2. Query Database SystemSettings
    try {
      const settingsMap = await settingService.getCategorySettings('maps');
      if (settingsMap.size > 0) {
        const primary =
          settingsMap.get('map.primary_provider')?.value?.trim() ||
          process.env.MAP_PROVIDER?.trim() ||
          'ola';

        const keys: Record<string, string> = {
          olaKey: resolveMapCredential(
            settingsMap.get('map.ola.api_key')?.value,
            process.env.OLA_MAPS_API_KEY,
            process.env.MAPS_API_KEY,
          ),
          googleKey: resolveMapCredential(
            settingsMap.get('map.google.api_key')?.value,
            process.env.GOOGLE_MAPS_API_KEY,
          ),
          mapplsRestKey: resolveMapCredential(
            settingsMap.get('map.mappls.rest_api_key')?.value,
            process.env.MAPPLS_REST_API_KEY,
            process.env.EXPO_PUBLIC_MAPPLS_REST_KEY,
          ),
          mapplsId: resolveMapCredential(
            settingsMap.get('map.mappls.client_id')?.value,
            process.env.MAPPLS_CLIENT_ID,
            process.env.EXPO_PUBLIC_MAPPLS_CLIENT_ID,
          ),
          mapplsSecret: resolveMapCredential(
            settingsMap.get('map.mappls.client_secret')?.value,
            process.env.MAPPLS_CLIENT_SECRET,
            process.env.EXPO_PUBLIC_MAPPLS_CLIENT_SECRET,
          ),
        };

        const baseUrls: Record<string, string> = {
          olaUrl:
            settingsMap.get('map.ola.base_url')?.value?.trim() ||
            process.env.OLA_MAPS_BASE_URL?.trim() ||
            '',
          googleUrl:
            settingsMap.get('map.google.base_url')?.value?.trim() ||
            process.env.GOOGLE_MAPS_BASE_URL?.trim() ||
            '',
          mapplsUrl:
            settingsMap.get('map.mappls.base_url')?.value?.trim() ||
            process.env.MAPPLS_BASE_URL?.trim() ||
            '',
        };

        if (redis) {
          try {
            const toCache: CachedMapSettings = { primaryProvider: primary, keys, baseUrls };
            await redis.provider.client.set(
              'geo:settings:maps',
              JSON.stringify(toCache),
              'EX',
              3600,
            );
          } catch (err) {
            logger.warn({ err }, '[MapProviderService] Redis map settings cache write failed');
          }
        }

        const chain = this.buildProviderChain(primary, keys, baseUrls);
        if (chain.length > 0) return chain;
      }
    } catch (err) {
      logger.warn(
        { err },
        '[MapProviderService] Dynamic provider resolution failed — using static active provider',
      );
    }

    const envOnlyChain = this.buildProviderChainFromEnv();
    if (envOnlyChain.length > 0) return envOnlyChain;

    return this.fallbackStaticChain();
  }

  private buildProviderChainFromEnv(): MapProvider[] {
    const envPrimary = (process.env.MAP_PROVIDER ?? 'ola').trim().toLowerCase();
    return this.buildProviderChain(envPrimary, {
      olaKey: resolveMapCredential(process.env.OLA_MAPS_API_KEY, process.env.MAPS_API_KEY),
      googleKey: resolveMapCredential(process.env.GOOGLE_MAPS_API_KEY),
      mapplsRestKey: resolveMapCredential(
        process.env.MAPPLS_REST_API_KEY,
        process.env.EXPO_PUBLIC_MAPPLS_REST_KEY,
      ),
      mapplsId: resolveMapCredential(
        process.env.MAPPLS_CLIENT_ID,
        process.env.EXPO_PUBLIC_MAPPLS_CLIENT_ID,
      ),
      mapplsSecret: resolveMapCredential(
        process.env.MAPPLS_CLIENT_SECRET,
        process.env.EXPO_PUBLIC_MAPPLS_CLIENT_SECRET,
      ),
    });
  }

  private fallbackStaticChain(): MapProvider[] {
    if (this.staticProviders.length > 0) {
      return this.staticProviders.slice(0, 1);
    }

    const configured = Object.values(this.registry).find((p) => p?.isConfigured());
    return configured ? [configured] : [];
  }

  private buildProviderChain(
    primaryName: string,
    keys?: Record<string, string>,
    baseUrls?: Record<string, string>,
  ): MapProvider[] {
    const normalizedPrimary = primaryName.trim().toLowerCase();
    let provider = this.registry[normalizedPrimary];

    if (normalizedPrimary === 'ola') {
      const apiKey = resolveMapCredential(
        keys?.olaKey,
        process.env.OLA_MAPS_API_KEY,
        process.env.MAPS_API_KEY,
      );
      if (apiKey) {
        const baseUrl = baseUrls?.olaUrl || process.env.OLA_MAPS_BASE_URL;
        provider = new OlaMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
        this.registry['ola'] = provider;
      }
    } else if (normalizedPrimary === 'google') {
      const apiKey = resolveMapCredential(keys?.googleKey, process.env.GOOGLE_MAPS_API_KEY);
      if (apiKey) {
        const baseUrl = baseUrls?.googleUrl || process.env.GOOGLE_MAPS_BASE_URL;
        provider = new GoogleMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
        this.registry['google'] = provider;
      }
    } else if (normalizedPrimary === 'mappls') {
      const restApiKey = resolveMapCredential(
        keys?.mapplsRestKey,
        process.env.MAPPLS_REST_API_KEY,
        process.env.EXPO_PUBLIC_MAPPLS_REST_KEY,
      );
      const clientId = resolveMapCredential(
        keys?.mapplsId,
        process.env.MAPPLS_CLIENT_ID,
        process.env.EXPO_PUBLIC_MAPPLS_CLIENT_ID,
      );
      const clientSecret = resolveMapCredential(
        keys?.mapplsSecret,
        process.env.MAPPLS_CLIENT_SECRET,
        process.env.EXPO_PUBLIC_MAPPLS_CLIENT_SECRET,
      );
      const baseUrl = baseUrls?.mapplsUrl || process.env.MAPPLS_BASE_URL;

      const config = buildMapplsProviderConfig({
        restApiKey,
        clientId,
        clientSecret,
        ...(baseUrl ? { baseUrl } : {}),
      });

      if (config) {
        provider = new MapplsProvider(config);
        this.registry['mappls'] = provider;
      }
    }

    if (provider && provider.isConfigured()) {
      return [provider];
    }

    return [];
  }

  // ─── Directions (Route Distance & ETA) ───────────────────────────────────────

  async getDirections(origin: Coordinate, destination: Coordinate): Promise<RoutingResult> {
    const chain = await this.resolveProviderChain();
    const provider = chain[0];

    if (!provider) {
      logger.error(
        { origin, destination },
        '[MapProviderService] No active map provider available',
      );
      throw new RoutingProviderUnavailableError();
    }

    try {
      return await provider.getDirections(origin, destination);
    } catch (err) {
      logger.warn(
        { provider: provider.providerName, err, origin, destination },
        '[MapProviderService] Active map provider call failed',
      );
      throw new RoutingProviderUnavailableError();
    }
  }

  // ─── Distance Matrix (Driver Candidate ETAs) ──────────────────────────────────

  async getDistanceMatrix(
    origins: Coordinate[],
    destinations: Coordinate[],
  ): Promise<MatrixResult> {
    if (origins.length === 0 || destinations.length === 0) {
      return { status: 'no_drivers', cells: [], providerName: 'none' };
    }

    const chain = await this.resolveProviderChain();
    const provider = chain[0];

    if (!provider) {
      return { status: 'unavailable', cells: [], providerName: 'none' };
    }

    try {
      const result = await provider.getDistanceMatrix(origins, destinations);
      return result;
    } catch (err) {
      logger.warn(
        { provider: provider.providerName, err },
        '[MapProviderService] Active map provider DistanceMatrix call failed',
      );
      return { status: 'unavailable', cells: [], providerName: 'none' };
    }
  }

  // ─── Address Search (Autocomplete) ──────────────────────────────────────────

  async autocomplete(input: string, location?: Coordinate): Promise<AutocompleteResult> {
    const chain = await this.resolveProviderChain();
    const provider = chain[0];

    if (!provider) {
      return { status: 'unavailable', predictions: [], providerName: 'none' };
    }

    try {
      return await provider.autocomplete(input, location);
    } catch (err) {
      logger.warn(
        { provider: provider.providerName, err, input },
        '[MapProviderService] Active map provider Autocomplete call failed',
      );
      return { status: 'unavailable', predictions: [], providerName: 'none' };
    }
  }

  // ─── Reverse Geocoding ───────────────────────────────────────────────────────

  async reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult> {
    const chain = await this.resolveProviderChain();
    const provider = chain[0];

    if (!provider) {
      throw new Error('No active reverse geocoding provider configured');
    }

    try {
      return await provider.reverseGeocode(coordinate);
    } catch (err) {
      logger.warn(
        { provider: provider.providerName, err, coordinate },
        '[MapProviderService] Active map provider ReverseGeocode call failed',
      );
      throw new Error(`Reverse geocoding failed on active provider '${provider.providerName}'`, {
        cause: err,
      });
    }
  }
}
