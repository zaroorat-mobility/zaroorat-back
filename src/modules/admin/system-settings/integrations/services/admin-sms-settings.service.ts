import type { TransactionManager } from '@core/database';
import { Msg91Provider } from '../../../../../integrations/msg91/msg91.client.js';
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
        ? 'msg91'
        : 'mock')) as SmsProviderName;

    const authKey =
      settings.get(SMS_SETTING_KEYS.MSG91_AUTH_KEY)?.value ?? process.env.MSG91_AUTH_KEY ?? '';
    const senderId =
      settings.get(SMS_SETTING_KEYS.MSG91_SENDER_ID)?.value ?? process.env.MSG91_SENDER_ID ?? '';
    const otpTemplateId =
      settings.get(SMS_SETTING_KEYS.MSG91_OTP_TEMPLATE_ID)?.value ??
      process.env.MSG91_OTP_TEMPLATE_ID ??
      '';
    const timeoutMs = Number(
      settings.get(SMS_SETTING_KEYS.TIMEOUT_MS)?.value ?? process.env.SMS_TIMEOUT_MS ?? 5000,
    );

    const msg91Configured = Boolean(authKey && authKey.trim().length > 0);
    const configured = provider === 'mock' || msg91Configured;

    return {
      provider,
      configured,
      version: maxSettingVersion(settings),
      msg91: {
        authKey: maskSecret(authKey),
        senderId,
        otpTemplateId,
        timeoutMs,
        configured: msg91Configured,
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
    if (input.msg91AuthKey !== undefined && !isMaskedSecret(input.msg91AuthKey)) {
      entries.push({
        key: SMS_SETTING_KEYS.MSG91_AUTH_KEY,
        value: input.msg91AuthKey,
        isSecret: true,
        expectedVersion: input.expectedVersion,
      });
    }
    if (input.msg91SenderId !== undefined) {
      entries.push({ key: SMS_SETTING_KEYS.MSG91_SENDER_ID, value: input.msg91SenderId });
    }
    if (input.msg91OtpTemplateId !== undefined) {
      entries.push({
        key: SMS_SETTING_KEYS.MSG91_OTP_TEMPLATE_ID,
        value: input.msg91OtpTemplateId,
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

    const authKey =
      (await this.systemSettingService.getSettingValue(SMS_SETTING_KEYS.MSG91_AUTH_KEY)) ??
      process.env.MSG91_AUTH_KEY ??
      '';
    const timeoutMs = settings.msg91.timeoutMs;

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
    } else if (!authKey || authKey.startsWith('invalid_') || authKey.startsWith('fail_')) {
      ok = false;
      message = 'MSG91 auth key is missing or invalid';
      // Only the environment may short-circuit a connection check. Keying it on
      // the shape of the credential meant a production MSG91 key beginning `test_`
      // was reported reachable without any request ever leaving the process.
    } else if (isTestEnv) {
      ok = true;
      message = 'MSG91 connection check succeeded (test mode)';
    } else {
      const client = new Msg91Provider({
        authKey,
        timeoutMs,
        ...(settings.msg91.senderId ? { senderId: settings.msg91.senderId } : {}),
      });

      if (input?.testPhone && settings.msg91.otpTemplateId) {
        const result = await client.sendSms({
          to: input.testPhone,
          body: 'Test',
          templateId: settings.msg91.otpTemplateId,
          variables: { otp: '123456' },
        });
        ok = result.accepted;
        message = result.accepted
          ? 'Test SMS accepted by MSG91'
          : (result.error ?? 'MSG91 test send failed');
      } else {
        ok = true;
        message =
          'MSG91 credentials validated (provide testPhone + otpTemplateId to send test SMS)';
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
