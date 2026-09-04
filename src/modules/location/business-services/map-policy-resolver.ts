import type { MapCapability } from '../types/map-capabilities.types.js';
import {
  DEFAULT_MAP_POLICY,
  DEFAULT_PROVIDER_CAPABILITIES,
  type MapPolicySettings,
} from '../types/map-capabilities.types.js';
import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';
import {
  DEFAULT_MAP_PROVIDERS,
  MAP_SETTING_KEYS,
  MAP_SETTINGS_CATEGORY,
} from '@modules/admin/system-settings/map/constants/map-settings.constants.js';
import { resolveMapCredential } from '../../../integrations/mappls/mappls-credentials.util.js';
import type { SystemSettingService } from '@modules/admin/system-settings/services/system-setting.service.js';

export interface CachedMapSettings extends MapPolicySettings {
  keys?: Record<string, string>;
  baseUrls?: Record<string, string>;
  clientSdkKeys?: Record<string, string>;
}

function parseBoolean(value: string | null | undefined, fallback = false): boolean {
  if (value == null || value.trim() === '') return fallback;
  return value.trim().toLowerCase() === 'true';
}

function parseFallbackByCapability(
  raw: string | null | undefined,
): Partial<Record<MapCapability, MapProviderName[]>> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<Record<MapCapability, MapProviderName[]>>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function buildMapSettingsFromEnv(): CachedMapSettings {
  const primary = (process.env.MAP_PROVIDER ?? DEFAULT_MAP_PROVIDERS.PRIMARY)
    .trim()
    .toLowerCase() as MapProviderName;
  const enabled: MapProviderName[] = [];
  if (resolveMapCredential(process.env.OLA_MAPS_API_KEY, process.env.MAPS_API_KEY))
    enabled.push('ola');
  if (resolveMapCredential(process.env.GOOGLE_MAPS_API_KEY)) enabled.push('google');
  if (
    resolveMapCredential(process.env.MAPPLS_REST_API_KEY) ||
    (resolveMapCredential(process.env.MAPPLS_CLIENT_ID) &&
      resolveMapCredential(process.env.MAPPLS_CLIENT_SECRET))
  ) {
    enabled.push('mappls');
  }
  if (!enabled.includes(primary) && enabled.length > 0) {
    return { ...DEFAULT_MAP_POLICY, primaryProvider: enabled[0]!, enabledProviders: enabled };
  }
  return {
    ...DEFAULT_MAP_POLICY,
    primaryProvider: primary,
    enabledProviders: enabled.length > 0 ? enabled : [primary],
  };
}

export async function resolveMapPolicyFromSettings(
  settingService: SystemSettingService,
): Promise<CachedMapSettings> {
  const settingsMap = await settingService.getCategorySettings(MAP_SETTINGS_CATEGORY);
  if (settingsMap.size === 0) {
    return buildMapSettingsFromEnv();
  }

  const primaryProvider = (
    settingsMap.get(MAP_SETTING_KEYS.PRIMARY_PROVIDER)?.value ??
    process.env.MAP_PROVIDER ??
    DEFAULT_MAP_PROVIDERS.PRIMARY
  )
    .trim()
    .toLowerCase() as MapProviderName;

  const enabledProviders: MapProviderName[] = [primaryProvider];

  const configVersion = Number(settingsMap.get(MAP_SETTING_KEYS.CONFIG_VERSION)?.value ?? '0') || 0;

  return {
    primaryProvider,
    enabledProviders,
    fallbackEnabled: parseBoolean(settingsMap.get(MAP_SETTING_KEYS.FALLBACK_ENABLED)?.value, false),
    fallbackByCapability: parseFallbackByCapability(
      settingsMap.get(MAP_SETTING_KEYS.FALLBACK_BY_CAPABILITY)?.value,
    ),
    configVersion,
    keys: {
      olaKey: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.OLA_API_KEY)?.value,
        process.env.OLA_MAPS_API_KEY,
        process.env.MAPS_API_KEY,
      ),
      googleKey: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.GOOGLE_API_KEY)?.value,
        process.env.GOOGLE_MAPS_API_KEY,
      ),
      mapplsRestKey: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY)?.value,
        process.env.MAPPLS_REST_API_KEY,
      ),
      mapplsId: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value,
        process.env.MAPPLS_CLIENT_ID,
      ),
      mapplsSecret: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET)?.value,
        process.env.MAPPLS_CLIENT_SECRET,
      ),
    },
    baseUrls: {
      olaUrl:
        settingsMap.get(MAP_SETTING_KEYS.OLA_BASE_URL)?.value?.trim() ||
        process.env.OLA_MAPS_BASE_URL?.trim() ||
        '',
      googleUrl:
        settingsMap.get(MAP_SETTING_KEYS.GOOGLE_BASE_URL)?.value?.trim() ||
        process.env.GOOGLE_MAPS_BASE_URL?.trim() ||
        '',
      mapplsUrl:
        settingsMap.get(MAP_SETTING_KEYS.MAPPLS_BASE_URL)?.value?.trim() ||
        process.env.MAPPLS_BASE_URL?.trim() ||
        '',
    },
    clientSdkKeys: {
      olaClientSdkKey: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.OLA_CLIENT_SDK_KEY)?.value,
        process.env.OLA_MAPS_CLIENT_SDK_KEY,
      ),
      googleClientSdkKey: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY)?.value,
        process.env.GOOGLE_MAPS_CLIENT_SDK_KEY,
      ),
      mapplsClientSdkKey: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SDK_KEY)?.value,
        process.env.MAPPLS_CLIENT_SDK_KEY,
      ),
    },
  };
}

export function providerCapabilities(name: MapProviderName): readonly MapCapability[] {
  return DEFAULT_PROVIDER_CAPABILITIES[name];
}
