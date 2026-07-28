import { config } from '@config';
import { MockProvider } from './providers/mock.provider';
import { Msg91Provider } from './providers/msg91.provider';
import type { SmsProvider } from './providers/sms.provider';

export type SmsProviderName = 'mock' | 'msg91';

/** Resolved notification settings. MSG91 fields are read from the environment
 *  (consistent with the DB pool config) and are absent in mock environments. */
export interface NotificationConfig {
  smsProvider: SmsProviderName;
  /** MSG91 template used for OTP delivery (required when provider is `msg91`). */
  otpTemplateId?: string;
  msg91: { authKey: string; senderId?: string } | null;
}

/**
 * Build the notification configuration from the environment.
 *
 * The provider defaults to `mock` in development/test and `msg91` in
 * staging/production, overridable with `SMS_PROVIDER`. MSG91 credentials come
 * from `MSG91_AUTH_KEY` / `MSG91_SENDER_ID` / `MSG91_OTP_TEMPLATE_ID`.
 * @returns The resolved configuration.
 */
export function getNotificationConfig(): NotificationConfig {
  const explicit = process.env.SMS_PROVIDER as SmsProviderName | undefined;
  const env = config.app.environment;
  const smsProvider: SmsProviderName =
    explicit ?? (env === 'production' || env === 'staging' ? 'msg91' : 'mock');

  const authKey = process.env.MSG91_AUTH_KEY;
  const senderId = process.env.MSG91_SENDER_ID;
  const msg91 = authKey ? { authKey, ...(senderId ? { senderId } : {}) } : null;

  return {
    smsProvider,
    msg91,
    ...(process.env.MSG91_OTP_TEMPLATE_ID
      ? { otpTemplateId: process.env.MSG91_OTP_TEMPLATE_ID }
      : {}),
  };
}

/**
 * Provider factory — selects the concrete {@link SmsProvider} from config.
 *
 * Fails fast if `msg91` is selected without credentials, so a misconfigured
 * production instance cannot silently drop OTP SMS.
 * @param notificationConfig Resolved notification configuration.
 * @returns The chosen SMS provider instance.
 * @throws Error when `msg91` is selected but `MSG91_AUTH_KEY` is missing.
 */
export function createSmsProvider(notificationConfig: NotificationConfig): SmsProvider {
  if (notificationConfig.smsProvider === 'msg91') {
    if (!notificationConfig.msg91) {
      throw new Error('SMS provider "msg91" selected but MSG91_AUTH_KEY is not configured');
    }
    return new Msg91Provider(notificationConfig.msg91);
  }
  return new MockProvider();
}
