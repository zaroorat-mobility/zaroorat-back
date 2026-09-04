export const MAP_SETTINGS_CATEGORY = 'maps';
export const MAP_SETTINGS_CACHE_KEY = 'geo:settings:maps';
export const MASKED_SECRET_VALUE = '********';

export const MAP_SETTING_KEYS = {
  PRIMARY_PROVIDER: 'map.primary_provider',
  FALLBACK_PROVIDERS: 'map.fallback_providers',
  FALLBACK_ENABLED: 'map.fallback.enabled',
  FALLBACK_BY_CAPABILITY: 'map.fallback.by_capability',
  CONFIG_VERSION: 'map.config_version',
  OLA_ENABLED: 'map.ola.enabled',
  OLA_API_KEY: 'map.ola.api_key',
  OLA_BASE_URL: 'map.ola.base_url',
  OLA_CLIENT_SDK_KEY: 'map.ola.client_sdk_key',
  GOOGLE_ENABLED: 'map.google.enabled',
  GOOGLE_API_KEY: 'map.google.api_key',
  GOOGLE_BASE_URL: 'map.google.base_url',
  GOOGLE_CLIENT_SDK_KEY: 'map.google.client_sdk_key',
  MAPPLS_ENABLED: 'map.mappls.enabled',
  MAPPLS_REST_API_KEY: 'map.mappls.rest_api_key',
  MAPPLS_CLIENT_ID: 'map.mappls.client_id',
  MAPPLS_CLIENT_SECRET: 'map.mappls.client_secret',
  MAPPLS_BASE_URL: 'map.mappls.base_url',
  MAPPLS_CLIENT_SDK_KEY: 'map.mappls.client_sdk_key',
} as const;

export const DEFAULT_MAP_PROVIDERS = {
  PRIMARY: 'ola',
} as const;

export const DEFAULT_BASE_URLS = {
  OLA: 'https://api.olamaps.io',
  GOOGLE: 'https://maps.googleapis.com/maps/api',
  /** Server-side routing (static REST / legacy fallback). Not used for map tiles. */
  MAPPLS: 'https://route.mappls.com/route/direction',
  /** Leaflet raster tiles — license key is embedded in the path. */
  MAPPLS_TILES: 'https://apis.mappls.com/advancedmaps/v1',
} as const;

/**
 * Raster layer path segment. The `map` street layer requires Maps API enabled in the
 * Mappls console; `bhuvan_imagery` works with more REST keys out of the box.
 */
export const DEFAULT_MAPPLS_TILE_LAYER = 'bhuvan_base';

export function buildMapplsTileUrl(
  licenseKey: string,
  tilesBase: string = DEFAULT_BASE_URLS.MAPPLS_TILES,
  tileLayer: string = process.env.MAPPLS_TILE_LAYER ?? DEFAULT_MAPPLS_TILE_LAYER,
): string {
  const base = tilesBase.replace(/\/+$/, '');
  const layer = tileLayer.replace(/^\/+|\/+$/g, '');
  return `${base}/${encodeURIComponent(licenseKey.trim())}/${layer}/{z}/{x}/{y}.png`;
}
