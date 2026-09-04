import { DatabaseService, TransactionManager } from '@core/database';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { MapProviderHealthService } from './map-provider-health.service.js';
import type { IntegrationHealthService } from '../../integrations/services/integration-health.service.js';
import { MapSettingsValidator } from '../validators/map-settings.validator.js';
import {
  buildMapplsTileUrl,
  DEFAULT_BASE_URLS,
  DEFAULT_MAP_PROVIDERS,
  MAP_SETTING_KEYS,
  MAP_SETTINGS_CATEGORY,
} from '../constants/map-settings.constants.js';
import {
  buildMapplsProviderConfig,
  resolveMapCredential,
  resolveMapplsTileLicenseKey,
} from '../../../../../integrations/mappls/mappls-credentials.util.js';
import { maxSettingVersion } from '../../integrations/utils/integration-settings.util.js';
import { providerCapabilities } from '@modules/location/business-services/map-policy-resolver.js';
import type {
  MapProviderName,
  MapSettingsView,
  PublicMapConfigView,
  TestProviderHealthInput,
  TestProviderHealthResult,
  UpdateMapSettingsBody,
} from '../types/map-settings.types.js';
import type { MapClientConfigView } from '../../integrations/types/integration-settings.types.js';

function parseBoolean(value: string | null | undefined, fallback = false): boolean {
  if (value == null || value.trim() === '') return fallback;
  return value.trim().toLowerCase() === 'true';
}

export class AdminMapSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly mapProviderHealthService: MapProviderHealthService,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly databaseService: DatabaseService,
    private readonly txManager: TransactionManager,
  ) {}

  async getMapSettings(): Promise<MapSettingsView> {
    const settings = await this.systemSettingService.getCategorySettings(MAP_SETTINGS_CATEGORY);

    const primaryProvider =
      settings.get(MAP_SETTING_KEYS.PRIMARY_PROVIDER)?.value ??
      process.env.MAP_PROVIDER ??
      DEFAULT_MAP_PROVIDERS.PRIMARY;

    const maxVersion = maxSettingVersion(settings);
    const configVersion =
      Number(settings.get(MAP_SETTING_KEYS.CONFIG_VERSION)?.value ?? maxVersion) || maxVersion;

    const olaKey = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.OLA_API_KEY)?.value,
      process.env.OLA_MAPS_API_KEY,
      process.env.MAPS_API_KEY,
    );
    const googleKey = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.GOOGLE_API_KEY)?.value,
      process.env.GOOGLE_MAPS_API_KEY,
    );
    const mapplsRestKey = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY)?.value,
      process.env.MAPPLS_REST_API_KEY,
      process.env.EXPO_PUBLIC_MAPPLS_REST_KEY,
    );
    const mapplsId = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value,
      process.env.MAPPLS_CLIENT_ID,
      process.env.EXPO_PUBLIC_MAPPLS_CLIENT_ID,
    );
    const mapplsSecret = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET)?.value,
      process.env.MAPPLS_CLIENT_SECRET,
      process.env.EXPO_PUBLIC_MAPPLS_CLIENT_SECRET,
    );
    const mapplsConfigured = Boolean(
      mapplsRestKey.trim() || (mapplsId.trim() && mapplsSecret.trim()) || mapplsId.trim(),
    );

    const olaEnabled = primaryProvider === 'ola';
    const googleEnabled = primaryProvider === 'google';
    const mapplsEnabled = primaryProvider === 'mappls';

    let fallbackByCapability: MapSettingsView['fallback']['byCapability'] = {};
    const fallbackRaw = settings.get(MAP_SETTING_KEYS.FALLBACK_BY_CAPABILITY)?.value;
    if (fallbackRaw?.trim()) {
      try {
        fallbackByCapability = JSON.parse(
          fallbackRaw,
        ) as MapSettingsView['fallback']['byCapability'];
      } catch {
        fallbackByCapability = {};
      }
    }

    return {
      primaryProvider,
      version: configVersion,
      fallback: {
        enabled: parseBoolean(settings.get(MAP_SETTING_KEYS.FALLBACK_ENABLED)?.value, false),
        byCapability: fallbackByCapability,
      },
      providers: {
        ola: {
          enabled: olaEnabled,
          configured: Boolean(olaKey),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.OLA_BASE_URL)?.value ??
            process.env.OLA_MAPS_BASE_URL ??
            DEFAULT_BASE_URLS.OLA,
          capabilities: [...providerCapabilities('ola')],
        },
        google: {
          enabled: googleEnabled,
          configured: Boolean(googleKey),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.GOOGLE_BASE_URL)?.value ??
            process.env.GOOGLE_MAPS_BASE_URL ??
            DEFAULT_BASE_URLS.GOOGLE,
          capabilities: [...providerCapabilities('google')],
        },
        mappls: {
          enabled: mapplsEnabled,
          configured: mapplsConfigured,
          baseUrl:
            settings.get(MAP_SETTING_KEYS.MAPPLS_BASE_URL)?.value ??
            process.env.MAPPLS_BASE_URL ??
            DEFAULT_BASE_URLS.MAPPLS,
          capabilities: [...providerCapabilities('mappls')],
        },
      },
    };
  }

  /** Admin LiveMap tile config — tile license for the active provider only. */
  async getMapClientConfig(): Promise<MapClientConfigView> {
    const settings = await this.getMapSettings();
    const settingsMap = await this.systemSettingService.getCategorySettings(MAP_SETTINGS_CATEGORY);
    const primary = settings.primaryProvider as MapProviderName;

    /// The browser-facing tile key: the platform-restricted client SDK key, and
    /// nothing else.
    ///
    /// This used to fall through to the backend REST key when no SDK key was
    /// configured — `map.ola.api_key`, `map.google.api_key`, the Mappls REST key.
    /// That key reached the admin bundle as `providers[name].apiKey`, and for
    /// Mappls it was embedded in the raster tile URL path, so it also travelled
    /// through every proxy and CDN log between the browser and Mappls. A server
    /// credential with full account quota and no referrer restriction is not a
    /// tile key; an unconfigured SDK key now yields no tiles instead.
    const resolveTileKey = (name: MapProviderName): string =>
      resolveMapCredential(
        settingsMap.get(
          name === 'ola'
            ? MAP_SETTING_KEYS.OLA_CLIENT_SDK_KEY
            : name === 'google'
              ? MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY
              : MAP_SETTING_KEYS.MAPPLS_CLIENT_SDK_KEY,
        )?.value,
        name === 'ola'
          ? process.env.OLA_MAPS_CLIENT_SDK_KEY
          : name === 'google'
            ? process.env.GOOGLE_MAPS_CLIENT_SDK_KEY
            : process.env.MAPPLS_CLIENT_SDK_KEY,
      );

    const buildProvider = (name: MapProviderName) => {
      const isPrimary = name === primary;
      const enabled = isPrimary && settings.providers[name].enabled;
      const providerBase =
        settings.providers[name].baseUrl ??
        (name === 'ola'
          ? DEFAULT_BASE_URLS.OLA
          : name === 'google'
            ? DEFAULT_BASE_URLS.GOOGLE
            : DEFAULT_BASE_URLS.MAPPLS);
      const baseUrl = (name === 'mappls' ? DEFAULT_BASE_URLS.MAPPLS_TILES : providerBase).replace(
        /\/+$/,
        '',
      );

      const config: {
        enabled: boolean;
        baseUrl: string;
        apiKey?: string;
        tileUrl?: string;
      } = { enabled, baseUrl };

      // Only the primary provider receives a tile key — one renderer at a time.
      if (!isPrimary || !enabled) {
        return config;
      }

      const tileKey = resolveTileKey(name);
      if (!tileKey) {
        return config;
      }

      config.apiKey = tileKey;
      if (name === 'ola') {
        config.baseUrl = providerBase.replace(/\/+$/, '');
        config.tileUrl = `${config.baseUrl}/tiles/v1/styles/default-light-standard/{z}/{x}/{y}.png`;
      } else if (name === 'mappls') {
        config.tileUrl = buildMapplsTileUrl(tileKey);
      }

      return config;
    };

    return {
      primaryProvider: primary,
      providers: {
        ola: buildProvider('ola'),
        google: buildProvider('google'),
        mappls: buildProvider('mappls'),
      },
    };
  }

  /** Secret-free runtime config for authenticated mobile and admin clients. */
  async getPublicMapConfig(): Promise<PublicMapConfigView> {
    const settings = await this.getMapSettings();
    const settingsMap = await this.systemSettingService.getCategorySettings(MAP_SETTINGS_CATEGORY);
    const primary = settings.primaryProvider as MapProviderName;

    const clientSdk = {
      ola: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.OLA_CLIENT_SDK_KEY)?.value,
        process.env.OLA_MAPS_CLIENT_SDK_KEY,
      ),
      google: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY)?.value,
        process.env.GOOGLE_MAPS_CLIENT_SDK_KEY,
      ),
      mappls: resolveMapCredential(
        settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SDK_KEY)?.value,
        process.env.MAPPLS_CLIENT_SDK_KEY,
      ),
    };

    const olaBase = settings.providers.ola.baseUrl ?? DEFAULT_BASE_URLS.OLA;

    const mapplsTileFromSdk = clientSdk.mappls;
    const mapplsTileFromServer = resolveMapplsTileLicenseKey(
      buildMapplsProviderConfig({
        restApiKey: resolveMapCredential(
          settingsMap.get(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY)?.value,
          process.env.MAPPLS_REST_API_KEY,
        ),
        clientId: resolveMapCredential(
          settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value,
          process.env.MAPPLS_CLIENT_ID,
        ),
        clientSecret: resolveMapCredential(
          settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET)?.value,
          process.env.MAPPLS_CLIENT_SECRET,
        ),
      }) ?? { restApiKey: '' },
    );
    const mapplsTileKey = mapplsTileFromSdk || mapplsTileFromServer;

    const buildProvider = (name: MapProviderName) => {
      const enabled = settings.providers[name].enabled;
      const sdkKey = clientSdk[name];
      const baseUrl = settings.providers[name].baseUrl;
      const out: PublicMapConfigView['providers'][MapProviderName] = { enabled };
      if (baseUrl) out.baseUrl = baseUrl.replace(/\/+$/, '');
      if (enabled && sdkKey) {
        out.clientSdkKey = sdkKey;
        if (name === 'ola') {
          out.tileUrl = `${olaBase.replace(/\/+$/, '')}/tiles/v1/styles/default-light-standard/{z}/{x}/{y}.png`;
        } else if (name === 'mappls' && mapplsTileKey) {
          out.tileUrl = buildMapplsTileUrl(mapplsTileKey);
          out.baseUrl = DEFAULT_BASE_URLS.MAPPLS_TILES;
        }
      }
      return out;
    };

    const attribution =
      primary === 'google'
        ? { text: '© Google' }
        : primary === 'mappls'
          ? { text: 'Powered by Mappls' }
          : { text: '© Ola Maps' };

    return {
      primaryProvider: primary,
      configVersion: settings.version,
      capabilities: [...providerCapabilities(primary)],
      attribution,
      minClientAdapterVersion: '1.0.0',
      providers: {
        ola: buildProvider('ola'),
        google: buildProvider('google'),
        mappls: buildProvider('mappls'),
      },
    };
  }

  async testProviderHealth(input: TestProviderHealthInput): Promise<TestProviderHealthResult> {
    const result = await this.mapProviderHealthService.testProviderHealth(input);
    await this.integrationHealthService.recordProbe('maps', input.providerName, {
      ok: result.ok,
      responseTimeMs: result.responseTimeMs,
      message: result.message,
      configured: true,
    });
    return result;
  }

  async updateMapSettings(
    input: UpdateMapSettingsBody,
    actorId?: string,
  ): Promise<MapSettingsView> {
    const current = await this.getMapSettings();
    MapSettingsValidator.validateUpdateInput(input, current);

    const { primaryProvider } = input;

    const healthInput: TestProviderHealthInput = { providerName: primaryProvider };

    if (primaryProvider === 'ola' && input.providers?.ola) {
      if (input.providers.ola.apiKey) healthInput.apiKey = input.providers.ola.apiKey;
      if (input.providers.ola.baseUrl) healthInput.baseUrl = input.providers.ola.baseUrl;
    } else if (primaryProvider === 'google' && input.providers?.google) {
      if (input.providers.google.apiKey) healthInput.apiKey = input.providers.google.apiKey;
      if (input.providers.google.baseUrl) healthInput.baseUrl = input.providers.google.baseUrl;
    } else if (primaryProvider === 'mappls') {
      if (input.providers?.mappls?.restApiKey)
        healthInput.restApiKey = input.providers.mappls.restApiKey;
      if (input.providers?.mappls?.clientId) healthInput.clientId = input.providers.mappls.clientId;
      if (input.providers?.mappls?.clientSecret)
        healthInput.clientSecret = input.providers.mappls.clientSecret;
      if (input.providers?.mappls?.baseUrl) healthInput.baseUrl = input.providers.mappls.baseUrl;
    }

    const healthResult = await this.testProviderHealth(healthInput);
    if (!healthResult.ok) {
      throw new Error(
        `Cannot activate '${primaryProvider}' as primary provider: ${healthResult.message}`,
      );
    }

    const nextVersion = current.version + 1;

    await this.txManager.execute(async (tx) => {
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw new Error(
          `Map settings conflict: current version ${current.version}, expected ${input.expectedVersion}. Refresh and retry.`,
        );
      }

      const changes: Array<{
        fieldName: string;
        oldValue: string | null;
        newValue: string | null;
      }> = [];

      const saveSetting = async (key: string, value: string | null, isSecret = false) => {
        const oldSetting = await this.systemSettingService.getSettingRaw(key, tx);
        const oldValue = oldSetting?.value ?? null;
        await this.systemSettingService.setSetting(
          {
            key,
            value,
            category: MAP_SETTINGS_CATEGORY,
            isSecret,
            ...(actorId ? { updatedBy: actorId } : {}),
          },
          tx,
        );
        if (oldValue !== value) {
          changes.push({
            fieldName: key,
            oldValue: isSecret ? '[REDACTED]' : oldValue,
            newValue: isSecret ? '[REDACTED]' : value,
          });
        }
      };

      await saveSetting(MAP_SETTING_KEYS.PRIMARY_PROVIDER, primaryProvider);
      await saveSetting(MAP_SETTING_KEYS.CONFIG_VERSION, String(nextVersion));
      await saveSetting(MAP_SETTING_KEYS.FALLBACK_PROVIDERS, '');
      await saveSetting(
        MAP_SETTING_KEYS.FALLBACK_ENABLED,
        String(input.fallback?.enabled ?? current.fallback.enabled),
      );
      if (input.fallback?.byCapability) {
        await saveSetting(
          MAP_SETTING_KEYS.FALLBACK_BY_CAPABILITY,
          JSON.stringify(input.fallback.byCapability),
        );
      }

      const olaEnabled = primaryProvider === 'ola';
      const googleEnabled = primaryProvider === 'google';
      const mapplsEnabled = primaryProvider === 'mappls';

      await saveSetting(MAP_SETTING_KEYS.OLA_ENABLED, String(olaEnabled));
      await saveSetting(MAP_SETTING_KEYS.GOOGLE_ENABLED, String(googleEnabled));
      await saveSetting(MAP_SETTING_KEYS.MAPPLS_ENABLED, String(mapplsEnabled));

      if (input.providers?.ola) {
        const p = input.providers.ola;
        if (p.apiKey && !p.apiKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.OLA_API_KEY, p.apiKey, true);
        if (p.clientSdkKey && !p.clientSdkKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.OLA_CLIENT_SDK_KEY, p.clientSdkKey, true);
        if (p.baseUrl) await saveSetting(MAP_SETTING_KEYS.OLA_BASE_URL, p.baseUrl);
      }

      if (input.providers?.google) {
        const p = input.providers.google;
        if (p.apiKey && !p.apiKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.GOOGLE_API_KEY, p.apiKey, true);
        if (p.clientSdkKey && !p.clientSdkKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY, p.clientSdkKey, true);
        if (p.baseUrl) await saveSetting(MAP_SETTING_KEYS.GOOGLE_BASE_URL, p.baseUrl);
      }

      if (input.providers?.mappls) {
        const p = input.providers.mappls;
        if (p.restApiKey && !p.restApiKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY, p.restApiKey, true);
        if (p.clientId && !p.clientId.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID, p.clientId, true);
        if (p.clientSecret && !p.clientSecret.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET, p.clientSecret, true);
        if (p.clientSdkKey && !p.clientSdkKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.MAPPLS_CLIENT_SDK_KEY, p.clientSdkKey, true);
        if (p.baseUrl) await saveSetting(MAP_SETTING_KEYS.MAPPLS_BASE_URL, p.baseUrl);
      }

      if (changes.length > 0) {
        const log = await tx.adminActivityLog.create({
          data: {
            actorId: actorId ?? null,
            action: 'UPDATE',
            entityType: 'SystemSetting',
            entityId: null,
            summary: `Updated map provider policy (primary='${primaryProvider}', v${nextVersion})`,
            metadata: { primaryProvider, configVersion: nextVersion },
          },
        });
        await tx.auditFieldChange.createMany({
          data: changes.map((c) => ({
            activityLogId: log.id,
            fieldName: c.fieldName,
            oldValue: c.oldValue,
            newValue: c.newValue,
          })),
        });
      }
    });

    await this.systemSettingsCache.clearMapSettingsCache();
    return this.getMapSettings();
  }
}
