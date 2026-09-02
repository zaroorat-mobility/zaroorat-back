import type { TransactionManager } from '@core/database';
import { SmtpEmailProvider } from '@modules/notifications/providers/smtp.provider.js';
import { maskSecret } from '@shared/crypto/encryption.util.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import {
  EMAIL_SETTING_KEYS,
  EMAIL_SETTINGS_CATEGORY,
} from '../constants/integration-settings.constants.js';
import {
  isMaskedSecret,
  maxSettingVersion,
  saveIntegrationSettings,
} from '../utils/integration-settings.util.js';
import type { IntegrationHealthService } from './integration-health.service.js';
import type {
  EmailProviderName,
  IntegrationTestInput,
  IntegrationTestResult,
  EmailSettingsView,
  UpdateEmailSettingsBody,
} from '../types/integration-settings.types.js';

export class AdminEmailSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly txManager: TransactionManager,
  ) {}

  async getEmailSettings(): Promise<EmailSettingsView> {
    const settings = await this.systemSettingService.getCategorySettings(EMAIL_SETTINGS_CATEGORY);

    const provider = (settings.get(EMAIL_SETTING_KEYS.PROVIDER)?.value ??
      process.env.EMAIL_PROVIDER ??
      'smtp') as EmailProviderName;

    const host = settings.get(EMAIL_SETTING_KEYS.SMTP_HOST)?.value ?? process.env.SMTP_HOST ?? '';
    const port = Number(
      settings.get(EMAIL_SETTING_KEYS.SMTP_PORT)?.value ?? process.env.SMTP_PORT ?? 587,
    );
    const user = settings.get(EMAIL_SETTING_KEYS.SMTP_USER)?.value ?? process.env.SMTP_USER ?? '';
    const password =
      settings.get(EMAIL_SETTING_KEYS.SMTP_PASSWORD)?.value ?? process.env.SMTP_PASSWORD ?? '';
    const fromAddress =
      settings.get(EMAIL_SETTING_KEYS.FROM_ADDRESS)?.value ?? process.env.EMAIL_FROM ?? '';

    const smtpConfigured = Boolean(host && fromAddress);

    return {
      provider,
      configured: smtpConfigured,
      version: maxSettingVersion(settings),
      smtp: {
        host,
        port,
        user,
        password: maskSecret(password),
        fromAddress,
        configured: smtpConfigured,
      },
    };
  }

  async updateEmailSettings(
    input: UpdateEmailSettingsBody,
    actorId?: string,
  ): Promise<EmailSettingsView> {
    const before = await this.getEmailSettings();
    const entries = [];

    if (input.provider !== undefined) {
      entries.push({ key: EMAIL_SETTING_KEYS.PROVIDER, value: input.provider });
    }
    if (input.smtpHost !== undefined) {
      entries.push({ key: EMAIL_SETTING_KEYS.SMTP_HOST, value: input.smtpHost });
    }
    if (input.smtpPort !== undefined) {
      entries.push({ key: EMAIL_SETTING_KEYS.SMTP_PORT, value: String(input.smtpPort) });
    }
    if (input.smtpUser !== undefined) {
      entries.push({ key: EMAIL_SETTING_KEYS.SMTP_USER, value: input.smtpUser });
    }
    if (input.smtpPassword !== undefined && !isMaskedSecret(input.smtpPassword)) {
      entries.push({
        key: EMAIL_SETTING_KEYS.SMTP_PASSWORD,
        value: input.smtpPassword,
        isSecret: true,
        expectedVersion: input.expectedVersion,
      });
    }
    if (input.fromAddress !== undefined) {
      entries.push({ key: EMAIL_SETTING_KEYS.FROM_ADDRESS, value: input.fromAddress });
    }

    await saveIntegrationSettings(
      {
        systemSettingService: this.systemSettingService,
        systemSettingsCache: this.systemSettingsCache,
        txManager: this.txManager,
      },
      EMAIL_SETTINGS_CATEGORY,
      entries,
      actorId,
      'integration_email_settings',
      'Updated email integration settings',
      before,
    );

    return this.getEmailSettings();
  }

  async testEmail(input?: IntegrationTestInput): Promise<IntegrationTestResult> {
    const startTime = Date.now();
    const settings = await this.getEmailSettings();

    const host =
      (await this.systemSettingService.getSettingValue(EMAIL_SETTING_KEYS.SMTP_HOST)) ??
      process.env.SMTP_HOST ??
      '';
    const port = Number(
      (await this.systemSettingService.getSettingValue(EMAIL_SETTING_KEYS.SMTP_PORT)) ??
        process.env.SMTP_PORT ??
        587,
    );
    const user =
      (await this.systemSettingService.getSettingValue(EMAIL_SETTING_KEYS.SMTP_USER)) ??
      process.env.SMTP_USER ??
      '';
    const password =
      (await this.systemSettingService.getSettingValue(EMAIL_SETTING_KEYS.SMTP_PASSWORD)) ??
      process.env.SMTP_PASSWORD ??
      '';
    const fromAddress =
      (await this.systemSettingService.getSettingValue(EMAIL_SETTING_KEYS.FROM_ADDRESS)) ??
      process.env.EMAIL_FROM ??
      '';

    const provider = new SmtpEmailProvider({
      host,
      port,
      fromAddress,
      ...(user ? { user } : {}),
      ...(password ? { password } : {}),
    });

    const connection = await provider.testConnection();
    let ok = connection.ok;
    let message = connection.message;

    if (ok && input?.testEmail) {
      const sendResult = await provider.sendEmail({
        to: input.testEmail,
        subject: 'Zaroorat integration test',
        body: 'This is a test email from the Zaroorat admin integration settings panel.',
      });
      ok = sendResult.accepted;
      message = sendResult.accepted
        ? `Test email accepted for ${input.testEmail}`
        : (sendResult.error ?? 'Test email send failed');
    }

    const responseTimeMs = Date.now() - startTime;
    const result: IntegrationTestResult = {
      ok,
      integration: 'email',
      provider: settings.provider,
      message,
      responseTimeMs,
    };

    await this.integrationHealthService.recordProbe('email', settings.provider, {
      ok,
      responseTimeMs,
      message,
      configured: settings.configured,
    });

    return result;
  }

  getHealthFallback(view: EmailSettingsView) {
    return {
      integration: 'email' as const,
      provider: view.provider,
      configured: view.configured,
    };
  }
}
