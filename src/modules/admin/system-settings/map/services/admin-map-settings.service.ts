import { DatabaseService, TransactionManager } from '@core/database';
import { maskSecret } from '@shared/crypto/encryption.util.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { MapProviderHealthService } from './map-provider-health.service.js';
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

export class AdminMapSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly mapProviderHealthService: MapProviderHealthService,
    private readonly databaseService: DatabaseService,
    private readonly txManager: TransactionManager,
  ) {}

  /**
   * Get current map configuration (secrets masked as '********').
   * Enforces strict single active provider mode (fallbackProviders = []).
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
    const mapplsId =
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_ID)?.value ?? process.env.MAPPLS_CLIENT_ID ?? '';
    const mapplsSecret =
      settings.get(MAP_SETTING_KEYS.MAPPLS_CLIENT_SECRET)?.value ??
      process.env.MAPPLS_CLIENT_SECRET ??
      '';

    return {
      primaryProvider,
      fallbackProviders: [],
      version: maxVersion,
      providers: {
        ola: {
          enabled: primaryProvider === 'ola',
          configured: Boolean(olaKey && olaKey.trim().length > 0),
          apiKey: maskSecret(olaKey),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.OLA_BASE_URL)?.value ??
            process.env.OLA_MAPS_BASE_URL ??
            DEFAULT_BASE_URLS.OLA,
        },
        google: {
          enabled: primaryProvider === 'google',
          configured: Boolean(googleKey && googleKey.trim().length > 0),
          apiKey: maskSecret(googleKey),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.GOOGLE_BASE_URL)?.value ??
            process.env.GOOGLE_MAPS_BASE_URL ??
            DEFAULT_BASE_URLS.GOOGLE,
        },
        mappls: {
          enabled: primaryProvider === 'mappls',
          configured: Boolean(mapplsId && mapplsSecret),
          clientId: maskSecret(mapplsId),
          clientSecret: maskSecret(mapplsSecret),
          baseUrl:
            settings.get(MAP_SETTING_KEYS.MAPPLS_BASE_URL)?.value ??
            process.env.MAPPLS_BASE_URL ??
            DEFAULT_BASE_URLS.MAPPLS,
        },
      },
    };
  }

  /**
   * Test provider credentials and connectivity.
   */
  async testProviderHealth(input: TestProviderHealthInput): Promise<TestProviderHealthResult> {
    return this.mapProviderHealthService.testProviderHealth(input);
  }

  /**
   * Atomically update map configuration in database, record audit logs, and invalidate Redis cache.
   * Enforces strict single active provider mode.
   */
  async updateMapSettings(
    input: UpdateMapSettingsBody,
    actorId?: string,
  ): Promise<MapSettingsView> {
    const current = await this.getMapSettings();
    MapSettingsValidator.validateUpdateInput(input, current);

    const { primaryProvider } = input;

    // Safely extract health test input for target primary provider
    const healthInput: TestProviderHealthInput = {
      providerName: primaryProvider as MapProviderName,
    };

    if (primaryProvider === 'ola' && input.providers?.ola) {
      if (input.providers.ola.apiKey) healthInput.apiKey = input.providers.ola.apiKey;
      if (input.providers.ola.baseUrl) healthInput.baseUrl = input.providers.ola.baseUrl;
    } else if (primaryProvider === 'google' && input.providers?.google) {
      if (input.providers.google.apiKey) healthInput.apiKey = input.providers.google.apiKey;
      if (input.providers.google.baseUrl) healthInput.baseUrl = input.providers.google.baseUrl;
    } else if (primaryProvider === 'mappls' && input.providers?.mappls) {
      if (input.providers.mappls.clientId) healthInput.clientId = input.providers.mappls.clientId;
      if (input.providers.mappls.clientSecret)
        healthInput.clientSecret = input.providers.mappls.clientSecret;
      if (input.providers.mappls.baseUrl) healthInput.baseUrl = input.providers.mappls.baseUrl;
    }

    const healthResult = await this.testProviderHealth(healthInput);

    if (!healthResult.ok) {
      throw new Error(
        `Cannot activate '${primaryProvider}' as primary provider: ${healthResult.message}`,
      );
    }

    // Execute DB Transaction
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
      await saveSetting(MAP_SETTING_KEYS.FALLBACK_PROVIDERS, ''); // Strict single-provider mode: no fallback providers

      // Atomically enable primary provider and disable others
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
            metadata: { primaryProvider, fallbackProviders: [] },
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

    // Invalidate Redis settings cache after successful DB commit
    await this.systemSettingsCache.clearMapSettingsCache();

    return this.getMapSettings();
  }
}
