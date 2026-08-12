import { config } from '@config';
import { MockProvider } from './providers/mock.provider';
import { Msg91Provider } from './providers/msg91.provider';
import type { SmsProvider } from './providers/sms.provider';

export type SmsProviderName = 'mock' | 'msg91';

export interface NotificationConfig {
  smsProvider: SmsProviderName;
  otpTemplateId?: string;
  msg91: { authKey: string; senderId?: string } | null;
}

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

export function createSmsProvider(notificationConfig: NotificationConfig): SmsProvider {
  if (notificationConfig.smsProvider === 'msg91') {
    if (!notificationConfig.msg91) {
      throw new Error('SMS provider "msg91" selected but MSG91_AUTH_KEY is not configured');
    }
    return new Msg91Provider(notificationConfig.msg91);
  }
  return new MockProvider();
}
