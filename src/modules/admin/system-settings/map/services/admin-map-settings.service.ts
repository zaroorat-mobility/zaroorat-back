import { DatabaseService, TransactionManager } from '@core/database';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { MapProviderHealthService } from './map-provider-health.service.js';
import type { IntegrationHealthService } from '../../integrations/services/integration-health.service.js';
import { MapSettingsValidator } from '../validators/map-settings.validator.js';
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MAP_PROVIDERS,
  MAP_SETTING_KEYS,
  MAP_SETTINGS_CATEGORY,
} from '../constants/map-settings.constants.js';
import type {
  MapProviderName,
  MapSettingsView,
  TestProviderHealthInput,
  TestProviderHealthResult,
  UpdateMapSettingsBody,
} from '../types/map-settings.types.js';
import type { MapClientConfigView } from '../../integrations/types/integration-settings.types.js';

export class AdminMapSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly mapProviderHealthService: MapProviderHealthService,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly databaseService: DatabaseService,
    private readonly txManager: TransactionManager,
  ) {}

  /**
   * Get current map configuration.
   * Secrets are never returned — only `configured` flags and non-secret fields.
   * Exactly one provider is active (primaryProvider).
   */
  async getMapSettings(): Promise<MapSettingsView> {
    const settings = await this.systemSettingService.getCategorySettings(MAP_SETTINGS_CATEGORY);

    const primaryProvider =
      settings.get(MAP_SETTING_KEYS.PRIMARY_PROVIDER)?.value ??
      process.env.MAP_PROVIDER ??
      DEFAULT_MAP_PROVIDERS.PRIMARY;

    let maxVersion = 1;
    for (const item of settings.values()) {
      if (item.version > maxVersion) maxVersion = item.version;
    }

    const olaKey =
      settings.get(MAP_SETTING_KEYS.OLA_API_KEY)?.value ?? process.env.OLA_MAPS_API_KEY ?? '';
    const googleKey =
      settings.get(MAP_SETTING_KEYS.GOOGLE_API_KEY)?.value ?? process.env.GOOGLE_MAPS_API_KEY ?? '';
    const mapplsRestKey =
      settings.get(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY)?.value ??
      process.env.MAPPLS_REST_API_KEY ??
      '';
    const mapplsId =
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value ?? process.env.MAPPLS_CLIENT_ID ?? '';
    const mapplsSecret =
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET)?.value ??
      process.env.MAPPLS_CLIENT_SECRET ??
      '';
    const mapplsConfigured = Boolean(
      mapplsRestKey.trim() || (mapplsId.trim() && mapplsSecret.trim()) || mapplsId.trim(),
    );

    return {
      primaryProvider,
      version: maxVersion,
      providers: {
        ola: {
          enabled: primaryProvider === 'ola',
          configured: Boolean(olaKey && olaKey.trim().length > 0),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.OLA_BASE_URL)?.value ??
            process.env.OLA_MAPS_BASE_URL ??
            DEFAULT_BASE_URLS.OLA,
        },
        google: {
          enabled: primaryProvider === 'google',
          configured: Boolean(googleKey && googleKey.trim().length > 0),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.GOOGLE_BASE_URL)?.value ??
            process.env.GOOGLE_MAPS_BASE_URL ??
            DEFAULT_BASE_URLS.GOOGLE,
        },
        mappls: {
          enabled: primaryProvider === 'mappls',
          configured: mapplsConfigured,
          baseUrl:
            settings.get(MAP_SETTING_KEYS.MAPPLS_BASE_URL)?.value ??
            process.env.MAPPLS_BASE_URL ??
            DEFAULT_BASE_URLS.MAPPLS,
        },
      },
    };
  }

  /**
   * Map configuration for authenticated admin clients (LiveMap tile layers).
   * Includes the active provider's API key — required for browser-side tile requests.
   * Only exposed to admins with settings:read; server-side routing keeps keys internal.
   */
  async getMapClientConfig(): Promise<MapClientConfigView> {
    const settingsMap = await this.systemSettingService.getCategorySettings(MAP_SETTINGS_CATEGORY);

    const primaryProvider =
      settingsMap.get(MAP_SETTING_KEYS.PRIMARY_PROVIDER)?.value ??
      process.env.MAP_PROVIDER ??
      DEFAULT_MAP_PROVIDERS.PRIMARY;

    const olaKey =
      settingsMap.get(MAP_SETTING_KEYS.OLA_API_KEY)?.value?.trim() ||
      process.env.OLA_MAPS_API_KEY?.trim() ||
      '';
    const googleKey =
      settingsMap.get(MAP_SETTING_KEYS.GOOGLE_API_KEY)?.value?.trim() ||
      process.env.GOOGLE_MAPS_API_KEY?.trim() ||
      '';
    const mapplsRestKey =
      settingsMap.get(MAP_SETTING_KEYS.MAPPLS_REST_API_KEY)?.value?.trim() ||
      process.env.MAPPLS_REST_API_KEY?.trim() ||
      settingsMap.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value?.trim() ||
      process.env.MAPPLS_CLIENT_ID?.trim() ||
      '';

    const olaBase =
      settingsMap.get(MAP_SETTING_KEYS.OLA_BASE_URL)?.value ??
      process.env.OLA_MAPS_BASE_URL ??
      DEFAULT_BASE_URLS.OLA;
    const googleBase =
      settingsMap.get(MAP_SETTING_KEYS.GOOGLE_BASE_URL)?.value ??
      process.env.GOOGLE_MAPS_BASE_URL ??
      DEFAULT_BASE_URLS.GOOGLE;
    const mapplsBase =
      settingsMap.get(MAP_SETTING_KEYS.MAPPLS_BASE_URL)?.value ??
      process.env.MAPPLS_BASE_URL ??
      DEFAULT_BASE_URLS.MAPPLS;

    const buildProvider = (
      name: 'ola' | 'google' | 'mappls',
      enabled: boolean,
      baseUrl: string,
      apiKey: string,
    ) => {
      const normalizedBase = baseUrl.replace(/\/+$/, '');
      const config: {
        enabled: boolean;
        baseUrl: string;
        apiKey?: string;
        tileUrl?: string;
      } = { enabled, baseUrl: normalizedBase };

      if (enabled && apiKey) {
        config.apiKey = apiKey;
        if (name === 'ola') {
          config.tileUrl = `${normalizedBase}/tiles/v1/styles/default-light-standard/{z}/{x}/{y}.png`;
        }
      }

      return config;
    };

    return {
      primaryProvider,
      providers: {
        ola: buildProvider('ola', primaryProvider === 'ola', olaBase, olaKey),
        google: buildProvider('google', primaryProvider === 'google', googleBase, googleKey),
        mappls: buildProvider('mappls', primaryProvider === 'mappls', mapplsBase, mapplsRestKey),
      },
    };
  }

  /**
   * Test provider credentials and connectivity.
   */
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

  /**
   * Atomically update map configuration: exactly one active provider.
   * Requires a successful health check before activation.
   */
  async updateMapSettings(
    input: UpdateMapSettingsBody,
    actorId?: string,
  ): Promise<MapSettingsView> {
    const current = await this.getMapSettings();
    MapSettingsValidator.validateUpdateInput(input, current);

    const { primaryProvider } = input;

    const healthInput: TestProviderHealthInput = {
      providerName: primaryProvider as MapProviderName,
    };

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

    await this.txManager.execute(async (tx) => {
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
            ...(input.expectedVersion !== undefined
              ? { expectedVersion: input.expectedVersion }
              : {}),
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
      // Clear any legacy fallback setting — single-provider mode only
      await saveSetting(MAP_SETTING_KEYS.FALLBACK_PROVIDERS, '');

      await saveSetting(MAP_SETTING_KEYS.OLA_ENABLED, String(primaryProvider === 'ola'));
      await saveSetting(MAP_SETTING_KEYS.GOOGLE_ENABLED, String(primaryProvider === 'google'));
      await saveSetting(MAP_SETTING_KEYS.MAPPLS_ENABLED, String(primaryProvider === 'mappls'));

      if (input.providers?.ola) {
        const p = input.providers.ola;
        if (p.apiKey && !p.apiKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.OLA_API_KEY, p.apiKey, true);
        if (p.baseUrl) await saveSetting(MAP_SETTING_KEYS.OLA_BASE_URL, p.baseUrl);
      }

      if (input.providers?.google) {
        const p = input.providers.google;
        if (p.apiKey && !p.apiKey.startsWith('***'))
          await saveSetting(MAP_SETTING_KEYS.GOOGLE_API_KEY, p.apiKey, true);
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
        if (p.baseUrl) await saveSetting(MAP_SETTING_KEYS.MAPPLS_BASE_URL, p.baseUrl);
      }

      if (changes.length > 0) {
        const log = await tx.adminActivityLog.create({
          data: {
            actorId: actorId ?? null,
            action: 'UPDATE',
            entityType: 'SystemSetting',
            entityId: null,
            summary: `Updated active map provider to '${primaryProvider}'`,
            metadata: { primaryProvider },
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
