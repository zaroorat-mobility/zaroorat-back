import type { TransactionManager } from '@core/database';
import { maskSecret } from '@shared/crypto/encryption.util.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import {
  PUSH_SETTING_KEYS,
  PUSH_SETTINGS_CATEGORY,
} from '../constants/integration-settings.constants.js';
import {
  isMaskedSecret,
  maxSettingVersion,
  saveIntegrationSettings,
} from '../utils/integration-settings.util.js';
import type { IntegrationHealthService } from './integration-health.service.js';
import type {
  IntegrationTestInput,
  IntegrationTestResult,
  PushProviderName,
  PushSettingsView,
  UpdatePushSettingsBody,
} from '../types/integration-settings.types.js';

export class AdminPushSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly txManager: TransactionManager,
  ) {}

  async getPushSettings(): Promise<PushSettingsView> {
    const settings = await this.systemSettingService.getCategorySettings(PUSH_SETTINGS_CATEGORY);

    const provider = (settings.get(PUSH_SETTING_KEYS.PROVIDER)?.value ??
      process.env.PUSH_PROVIDER ??
      'mock') as PushProviderName;

    const serverKey =
      settings.get(PUSH_SETTING_KEYS.FCM_SERVER_KEY)?.value ?? process.env.FCM_SERVER_KEY ?? '';

    const fcmConfigured = Boolean(serverKey && serverKey.trim().length > 0);
    const configured = provider !== 'mock' ? fcmConfigured : true;

    return {
      provider,
      configured,
      version: maxSettingVersion(settings),
      fcm: {
        serverKey: maskSecret(serverKey),
        configured: fcmConfigured,
      },
    };
  }

  async updatePushSettings(
    input: UpdatePushSettingsBody,
    actorId?: string,
  ): Promise<PushSettingsView> {
    const before = await this.getPushSettings();
    const entries = [];

    if (input.provider !== undefined) {
      entries.push({ key: PUSH_SETTING_KEYS.PROVIDER, value: input.provider });
    }
    if (input.fcmServerKey !== undefined && !isMaskedSecret(input.fcmServerKey)) {
      entries.push({
        key: PUSH_SETTING_KEYS.FCM_SERVER_KEY,
        value: input.fcmServerKey,
        isSecret: true,
        expectedVersion: input.expectedVersion,
      });
    }

    await saveIntegrationSettings(
      {
        systemSettingService: this.systemSettingService,
        systemSettingsCache: this.systemSettingsCache,
        txManager: this.txManager,
      },
      PUSH_SETTINGS_CATEGORY,
      entries,
      actorId,
      'integration_push_settings',
      'Updated push integration settings',
      before,
    );

    return this.getPushSettings();
  }

  async testPush(_input?: IntegrationTestInput): Promise<IntegrationTestResult> {
    const startTime = Date.now();
    const settings = await this.getPushSettings();
    const provider = settings.provider;

    const isTestEnv =
      process.env.NODE_ENV === 'test' ||
      process.env.APP_ENV === 'test' ||
      Boolean(process.env.VITEST) ||
      Boolean(process.env.JEST_WORKER_ID);

    let ok: boolean;
    let message: string;

    if (provider === 'mock') {
      ok = true;
      message = isTestEnv
        ? 'Mock push provider reachable (test mode — no delivery)'
        : 'Mock push provider configured (non-delivering — replace with FCM before production)';
    } else if (!settings.fcm.configured) {
      ok = false;
      message = 'FCM server key is not configured';
    } else {
      ok = true;
      message = 'FCM credentials present (provider not wired — stub health check only)';
    }

    const responseTimeMs = Date.now() - startTime;
    const result: IntegrationTestResult = {
      ok,
      integration: 'push',
      provider,
      message,
      responseTimeMs,
    };

    await this.integrationHealthService.recordProbe('push', provider, {
      ok,
      responseTimeMs,
      message,
      configured: settings.configured,
    });

    return result;
  }

  getHealthFallback(view: PushSettingsView) {
    return {
      integration: 'push' as const,
      provider: view.provider,
      configured: view.configured,
    };
  }
}
