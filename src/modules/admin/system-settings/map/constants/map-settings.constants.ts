export const MAP_SETTINGS_CATEGORY = 'maps';
export const MAP_SETTINGS_CACHE_KEY = 'geo:settings:maps';
export const MASKED_SECRET_VALUE = '********';

export const MAP_SETTING_KEYS = {
  PRIMARY_PROVIDER: 'map.primary_provider',
  FALLBACK_PROVIDERS: 'map.fallback_providers',
  OLA_ENABLED: 'map.ola.enabled',
  OLA_API_KEY: 'map.ola.api_key',
  OLA_BASE_URL: 'map.ola.base_url',
  GOOGLE_ENABLED: 'map.google.enabled',
  GOOGLE_API_KEY: 'map.google.api_key',
  GOOGLE_BASE_URL: 'map.google.base_url',
  MAPPLS_ENABLED: 'map.mappls.enabled',
  MAPPLS_REST_API_KEY: 'map.mappls.rest_api_key',
  MAPPLS_CLIENT_ID: 'map.mappls.client_id',
  MAPPLS_CLIENT_SECRET: 'map.mappls.client_secret',
  MAPPLS_BASE_URL: 'map.mappls.base_url',
} as const;

export const DEFAULT_MAP_PROVIDERS = {
  PRIMARY: 'ola',
} as const;

export const DEFAULT_BASE_URLS = {
  OLA: 'https://api.olamaps.io',
  GOOGLE: 'https://maps.googleapis.com/maps/api',
  MAPPLS: 'https://route.mappls.com/route/direction',
} as const;
