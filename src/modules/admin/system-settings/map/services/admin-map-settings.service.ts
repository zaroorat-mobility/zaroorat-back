import { DatabaseService, TransactionManager } from '@core/database';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { MapProviderHealthService } from './map-provider-health.service.js';
import type { IntegrationHealthService } from '../../integrations/services/integration-health.service.js';
import { MapSettingsValidator } from '../validators/map-settings.validator.js';
import {
  buildGoogleTileUrl,
  buildMapplsTileUrl,
  DEFAULT_BASE_URLS,
  DEFAULT_MAP_PROVIDERS,
  MAP_SETTING_KEYS,
  MAP_SETTINGS_CATEGORY,
} from '../constants/map-settings.constants.js';
import { resolveMapCredential } from '../../../../../integrations/mappls/mappls-credentials.util.js';
import { maxSettingVersion } from '../../integrations/utils/integration-settings.util.js';
import { MissingAuditActorError } from '../../../audit/index.js';
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
import { logger } from '@shared/logger/index.js';

/// The backend's Google credential, resolved exactly as MapProviderService does.
function googleServerKey(settingsMap: Map<string, { value: string | null }>): string {
  return resolveMapCredential(
    settingsMap.get(MAP_SETTING_KEYS.GOOGLE_API_KEY)?.value,
    process.env.GOOGLE_MAPS_API_KEY,
  );
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

    const googleKey = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.GOOGLE_API_KEY)?.value,
      process.env.GOOGLE_MAPS_API_KEY,
    );
    const mapplsRestKey = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY)?.value,
      process.env.MAPPLS_REST_API_KEY,
    );
    const mapplsId = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value,
      process.env.MAPPLS_CLIENT_ID,
    );
    const mapplsSecret = resolveMapCredential(
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET)?.value,
      process.env.MAPPLS_CLIENT_SECRET,
    );
    const mapplsConfigured = Boolean(
      mapplsRestKey.trim() || (mapplsId.trim() && mapplsSecret.trim()) || mapplsId.trim(),
    );

    const googleEnabled = primaryProvider === 'google';
    const mapplsEnabled = primaryProvider === 'mappls';

    return {
      primaryProvider,
      version: configVersion,
      providers: {
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
    /// nothing else. A "client" key equal to the server key would hand the
    /// unrestricted backend credential to the browser, so it is refused.
    const resolveTileKey = (name: MapProviderName): string => {
      const key = resolveMapCredential(
        settingsMap.get(
          name === 'google'
            ? MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY
            : MAP_SETTING_KEYS.MAPPLS_CLIENT_SDK_KEY,
        )?.value,
        name === 'google'
          ? process.env.GOOGLE_MAPS_CLIENT_SDK_KEY
          : process.env.MAPPLS_CLIENT_SDK_KEY,
      );
      if (name === 'google' && key && key === googleServerKey(settingsMap)) {
        logger.warn(
          '[AdminMapSettings] Google client SDK key equals the server key; not serving it. ' +
            'Configure a separate HTTP-referrer-restricted browser key.',
        );
        return '';
      }
      return key;
    };

    const buildProvider = (name: MapProviderName) => {
      const isPrimary = name === primary;
      const enabled = isPrimary && (settings.providers[name]?.enabled ?? false);
      const providerBase =
        settings.providers[name]?.baseUrl ??
        (name === 'google' ? DEFAULT_BASE_URLS.GOOGLE : DEFAULT_BASE_URLS.MAPPLS);
      const baseUrl = (name === 'mappls' ? DEFAULT_BASE_URLS.MAPPLS_TILES : providerBase).replace(
        /\/+$/,
        '',
      );

      const config: {
        enabled: boolean;
        baseUrl: string;
        clientSdkKey?: string;
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

      config.clientSdkKey = tileKey;
      if (name === 'google') {
        config.tileUrl = buildGoogleTileUrl(tileKey);
      } else if (name === 'mappls') {
        config.tileUrl = buildMapplsTileUrl(tileKey);
      }

      return config;
    };

    return {
      primaryProvider: primary,
      providers: {
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

    // No Google key goes to mobile clients: their Android Maps SDK key is built
    // into the binary, and nothing on the device reads one from here. Only the
    // Mappls native SDK takes its key at runtime.
    const mapplsSdkKey = resolveMapCredential(
      settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SDK_KEY)?.value,
      process.env.MAPPLS_CLIENT_SDK_KEY,
    );

    const buildProvider = (name: MapProviderName) => {
      const enabled = settings.providers[name]?.enabled ?? false;
      const baseUrl = settings.providers[name]?.baseUrl;
      const out: PublicMapConfigView['providers'][MapProviderName] = { enabled };
      if (baseUrl) out.baseUrl = baseUrl.replace(/\/+$/, '');
      if (name === 'mappls' && enabled && mapplsSdkKey) {
        out.clientSdkKey = mapplsSdkKey;
        out.tileUrl = buildMapplsTileUrl(mapplsSdkKey);
        out.baseUrl = DEFAULT_BASE_URLS.MAPPLS_TILES;
      }
      return out;
    };

    const attribution = primary === 'google' ? { text: '© Google' } : { text: 'Powered by Mappls' };

    return {
      primaryProvider: primary,
      configVersion: settings.version,
      capabilities: [...providerCapabilities(primary)],
      attribution,
      minClientAdapterVersion: '1.0.0',
      providers: {
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
    // Same rule as `recordAdminAction`: this path writes its audit row directly, so it
    // checks for the actor itself rather than recording a change to nobody.
    if (!actorId) throw new MissingAuditActorError('SystemSetting');
    const current = await this.getMapSettings();
    MapSettingsValidator.validateUpdateInput(input, current);

    const { primaryProvider } = input;

    const healthInput: TestProviderHealthInput = { providerName: primaryProvider };

    if (primaryProvider === 'google' && input.providers?.google) {
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

      const googleEnabled = primaryProvider === 'google';
      const mapplsEnabled = primaryProvider === 'mappls';

      await saveSetting(MAP_SETTING_KEYS.OLA_ENABLED, 'false');
      await saveSetting(MAP_SETTING_KEYS.GOOGLE_ENABLED, String(googleEnabled));
      await saveSetting(MAP_SETTING_KEYS.MAPPLS_ENABLED, String(mapplsEnabled));

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
            actorId,
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
