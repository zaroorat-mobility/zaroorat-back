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
import { decryptSecret } from '@shared/crypto/encryption.util.js';
import { container } from '@core/di';

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

  private getSettingService(): SystemSettingService | undefined {
    if (this.systemSettingService) return this.systemSettingService;
    try {
      return container.resolve('systemSettingService');
    } catch {
      return undefined;
    }
  }

  private getRedis(): RedisService | undefined {
    if (this.redisService) return this.redisService;
    try {
      return container.resolve('redisService');
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves the single active map provider for the application.
   */
  async resolveProviderChain(): Promise<MapProvider[]> {
    const settingService = this.getSettingService();
    const redis = this.getRedis();

    if (!settingService) {
      return this.staticProviders.slice(0, 1);
    }

    try {
      // 1. Check Redis cache
      if (redis) {
        const cachedJson = await redis.provider.client.get('geo:settings:maps');
        if (cachedJson) {
          const cached = JSON.parse(cachedJson) as CachedMapSettings;
          const chain = this.buildProviderChain(
            cached.primaryProvider,
            cached.keys,
            cached.baseUrls,
          );
          if (chain.length > 0) return chain;
        }
      }

      // 2. Query Database SystemSettings
      const settingsMap = await settingService.getCategorySettings('maps');
      if (settingsMap.size > 0) {
        const primary =
          settingsMap.get('map.primary_provider')?.value ?? process.env.MAP_PROVIDER ?? 'ola';

        const keys: Record<string, string> = {
          olaKey:
            settingsMap.get('map.ola.api_key')?.value ??
            process.env.OLA_MAPS_API_KEY ??
            process.env.MAPS_API_KEY ??
            '',
          googleKey:
            settingsMap.get('map.google.api_key')?.value ?? process.env.GOOGLE_MAPS_API_KEY ?? '',
          mapplsRestKey:
            settingsMap.get('map.mappls.rest_api_key')?.value ??
            process.env.MAPPLS_REST_API_KEY ??
            '',
          mapplsId:
            settingsMap.get('map.mappls.client_id')?.value ?? process.env.MAPPLS_CLIENT_ID ?? '',
          mapplsSecret:
            settingsMap.get('map.mappls.client_secret')?.value ??
            process.env.MAPPLS_CLIENT_SECRET ??
            '',
        };

        const baseUrls: Record<string, string> = {
          olaUrl: settingsMap.get('map.ola.base_url')?.value ?? process.env.OLA_MAPS_BASE_URL ?? '',
          googleUrl:
            settingsMap.get('map.google.base_url')?.value ?? process.env.GOOGLE_MAPS_BASE_URL ?? '',
          mapplsUrl:
            settingsMap.get('map.mappls.base_url')?.value ?? process.env.MAPPLS_BASE_URL ?? '',
        };

        // Cache in Redis for 1 hour
        if (redis) {
          const toCache: CachedMapSettings = {
            primaryProvider: primary,
            keys,
            baseUrls,
          };
          await redis.provider.client.set('geo:settings:maps', JSON.stringify(toCache), 'EX', 3600);
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

    return this.staticProviders.slice(0, 1);
  }

  private buildProviderChain(
    primaryName: string,
    keys?: Record<string, string>,
    baseUrls?: Record<string, string>,
  ): MapProvider[] {
    let provider = this.registry[primaryName];

    if (primaryName === 'ola') {
      const apiKey = keys?.olaKey
        ? decryptSecret(keys.olaKey)
        : (process.env.OLA_MAPS_API_KEY ?? process.env.MAPS_API_KEY ?? '');
      if (apiKey && (!provider || !provider.isConfigured())) {
        const baseUrl = baseUrls?.olaUrl || process.env.OLA_MAPS_BASE_URL;
        provider = new OlaMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
        this.registry['ola'] = provider;
      }
    } else if (primaryName === 'google') {
      const apiKey = keys?.googleKey
        ? decryptSecret(keys.googleKey)
        : (process.env.GOOGLE_MAPS_API_KEY ?? '');
      if (apiKey && (!provider || !provider.isConfigured())) {
        const baseUrl = baseUrls?.googleUrl || process.env.GOOGLE_MAPS_BASE_URL;
        provider = new GoogleMapsProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
        this.registry['google'] = provider;
      }
    } else if (primaryName === 'mappls') {
      const restApiKey = keys?.mapplsRestKey
        ? decryptSecret(keys.mapplsRestKey)
        : (process.env.MAPPLS_REST_API_KEY ?? '');
      const clientId = keys?.mapplsId
        ? decryptSecret(keys.mapplsId)
        : (process.env.MAPPLS_CLIENT_ID ?? '');
      const clientSecret = keys?.mapplsSecret
        ? decryptSecret(keys.mapplsSecret)
        : (process.env.MAPPLS_CLIENT_SECRET ?? '');
      const baseUrl = baseUrls?.mapplsUrl || process.env.MAPPLS_BASE_URL;

      const config =
        clientId && clientSecret
          ? {
              clientId,
              clientSecret,
              ...(restApiKey ? { restApiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            }
          : restApiKey || (!clientSecret && clientId)
            ? { restApiKey: restApiKey || clientId, ...(baseUrl ? { baseUrl } : {}) }
            : null;

      if (config && (!provider || !provider.isConfigured())) {
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
