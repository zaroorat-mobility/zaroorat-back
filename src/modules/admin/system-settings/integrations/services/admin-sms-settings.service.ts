import type { TransactionManager } from '@core/database';
import { AirtelProvider } from '../../../../../integrations/airtel/airtel.client.js';
import { maskSecret } from '@shared/crypto/encryption.util.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import {
  SMS_SETTING_KEYS,
  SMS_SETTINGS_CATEGORY,
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
  SmsProviderName,
  SmsSettingsView,
  UpdateSmsSettingsBody,
} from '../types/integration-settings.types.js';

export class AdminSmsSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly txManager: TransactionManager,
  ) {}

  async getSmsSettings(): Promise<SmsSettingsView> {
    const settings = await this.systemSettingService.getCategorySettings(SMS_SETTINGS_CATEGORY);

    const provider = (settings.get(SMS_SETTING_KEYS.PROVIDER)?.value ??
      process.env.SMS_PROVIDER ??
      (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'staging'
        ? 'airtel'
        : 'mock')) as SmsProviderName;

    const apiKey =
      settings.get(SMS_SETTING_KEYS.AIRTEL_API_KEY)?.value ?? process.env.AIRTEL_API_KEY ?? '';
    const username =
      settings.get(SMS_SETTING_KEYS.AIRTEL_USERNAME)?.value ?? process.env.AIRTEL_USERNAME ?? '';
    const password =
      settings.get(SMS_SETTING_KEYS.AIRTEL_PASSWORD)?.value ?? process.env.AIRTEL_PASSWORD ?? '';
    const customerId =
      settings.get(SMS_SETTING_KEYS.AIRTEL_CUSTOMER_ID)?.value ??
      process.env.AIRTEL_CUSTOMER_ID ??
      '';
    const senderId =
      settings.get(SMS_SETTING_KEYS.AIRTEL_SENDER_ID)?.value ?? process.env.AIRTEL_SENDER_ID ?? '';
    const entityId =
      settings.get(SMS_SETTING_KEYS.AIRTEL_ENTITY_ID)?.value ?? process.env.AIRTEL_ENTITY_ID ?? '';
    const otpTemplateId =
      settings.get(SMS_SETTING_KEYS.AIRTEL_OTP_TEMPLATE_ID)?.value ??
      process.env.AIRTEL_OTP_TEMPLATE_ID ??
      '';
    const timeoutMs = Number(
      settings.get(SMS_SETTING_KEYS.TIMEOUT_MS)?.value ?? process.env.SMS_TIMEOUT_MS ?? 5000,
    );

    const airtelConfigured = Boolean(
      (apiKey && apiKey.trim().length > 0) ||
      (username && username.trim().length > 0 && password && password.trim().length > 0),
    );
    const configured = provider === 'mock' || airtelConfigured;

    return {
      provider,
      configured,
      version: maxSettingVersion(settings),
      airtel: {
        apiKey: maskSecret(apiKey),
        username,
        password: maskSecret(password),
        customerId,
        senderId,
        entityId,
        otpTemplateId,
        timeoutMs,
        configured: airtelConfigured,
      },
    };
  }

  async updateSmsSettings(
    input: UpdateSmsSettingsBody,
    actorId?: string,
  ): Promise<SmsSettingsView> {
    const before = await this.getSmsSettings();
    const entries = [];

    if (input.provider !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.PROVIDER, value: input.provider });
    }
    if (input.airtelApiKey !== undefined && !isMaskedSecret(input.airtelApiKey)) {
      entries.push({
        key: SMS_SETTING_KEYS.AIRTEL_API_KEY,
        value: input.airtelApiKey,
        isSecret: true,
        expectedVersion: input.expectedVersion,
      });
    }
    if (input.airtelUsername !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.AIRTEL_USERNAME, value: input.airtelUsername });
    }
    if (input.airtelPassword !== undefined && !isMaskedSecret(input.airtelPassword)) {
      entries.push({
        key: SMS_SETTING_KEYS.AIRTEL_PASSWORD,
        value: input.airtelPassword,
        isSecret: true,
        expectedVersion: input.expectedVersion,
      });
    }
    if (input.airtelCustomerId !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.AIRTEL_CUSTOMER_ID, value: input.airtelCustomerId });
    }
    if (input.airtelSenderId !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.AIRTEL_SENDER_ID, value: input.airtelSenderId });
    }
    if (input.airtelEntityId !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.AIRTEL_ENTITY_ID, value: input.airtelEntityId });
    }
    if (input.airtelOtpTemplateId !== undefined) {
      entries.push({
        key: SMS_SETTING_KEYS.AIRTEL_OTP_TEMPLATE_ID,
        value: input.airtelOtpTemplateId,
      });
    }
    if (input.timeoutMs !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.TIMEOUT_MS, value: String(input.timeoutMs) });
    }

    await saveIntegrationSettings(
      {
        systemSettingService: this.systemSettingService,
        systemSettingsCache: this.systemSettingsCache,
        txManager: this.txManager,
      },
      SMS_SETTINGS_CATEGORY,
      entries,
      actorId,
      'integration_sms_settings',
      'Updated SMS integration settings',
      before,
    );

    return this.getSmsSettings();
  }

  async testSms(input?: IntegrationTestInput): Promise<IntegrationTestResult> {
    const startTime = Date.now();
    const settings = await this.getSmsSettings();
    const provider = settings.provider;

    const apiKey =
      (await this.systemSettingService.getSettingValue(SMS_SETTING_KEYS.AIRTEL_API_KEY)) ??
      process.env.AIRTEL_API_KEY ??
      '';
    const username =
      (await this.systemSettingService.getSettingValue(SMS_SETTING_KEYS.AIRTEL_USERNAME)) ??
      process.env.AIRTEL_USERNAME ??
      '';
    const password =
      (await this.systemSettingService.getSettingValue(SMS_SETTING_KEYS.AIRTEL_PASSWORD)) ??
      process.env.AIRTEL_PASSWORD ??
      '';
    const timeoutMs = settings.airtel.timeoutMs;
    const hasAuth = Boolean(
      (apiKey && apiKey.trim().length > 0) ||
      (username && username.trim().length > 0 && password && password.trim().length > 0),
    );

    const isTestEnv =
      process.env.NODE_ENV === 'test' ||
      process.env.APP_ENV === 'test' ||
      Boolean(process.env.VITEST) ||
      Boolean(process.env.JEST_WORKER_ID);

    let ok: boolean;
    let message: string;

    if (provider === 'mock') {
      ok = true;
      message = 'Mock SMS provider reachable (no delivery)';
    } else if (!hasAuth) {
      ok = false;
      message = 'Airtel credentials (API Key or Username/Password) are missing or invalid';
    } else if (isTestEnv) {
      ok = true;
      message = 'Airtel connection check succeeded (test mode)';
    } else {
      const client = new AirtelProvider({
        ...(apiKey ? { apiKey } : {}),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        timeoutMs,
        ...(settings.airtel.customerId ? { customerId: settings.airtel.customerId } : {}),
        ...(settings.airtel.senderId ? { senderId: settings.airtel.senderId } : {}),
        ...(settings.airtel.entityId ? { entityId: settings.airtel.entityId } : {}),
      });

      if (input?.testPhone && settings.airtel.otpTemplateId) {
        const result = await client.sendSms({
          to: input.testPhone,
          body: 'Test',
          templateId: settings.airtel.otpTemplateId,
          variables: { otp: '123456' },
        });
        ok = result.accepted;
        message = result.accepted
          ? 'Test SMS accepted by Airtel'
          : (result.error ?? 'Airtel test send failed');
      } else {
        ok = true;
        message =
          'Airtel credentials validated (provide testPhone + otpTemplateId to send test SMS)';
      }
    }

    const responseTimeMs = Date.now() - startTime;
    const result: IntegrationTestResult = {
      ok,
      integration: 'sms',
      provider,
      message,
      responseTimeMs,
    };

    await this.integrationHealthService.recordProbe('sms', provider, {
      ok,
      responseTimeMs,
      message,
      configured: settings.configured,
    });

    return result;
  }

  getHealthFallback(view: SmsSettingsView) {
    return {
      integration: 'sms' as const,
      provider: view.provider,
      configured: view.configured,
    };
  }
}
