import { config } from '@config';
import { MockProvider } from './providers/mock.provider';
import { Msg91Provider } from './providers/msg91.provider';
import type { SmsProvider } from './providers/sms.provider';
export type SmsProviderName = 'mock' | 'msg91';
const NON_DELIVERING_PROVIDERS: readonly SmsProviderName[] = Object.freeze(['mock']);
const DELIVERY_REQUIRED_ENVIRONMENTS: readonly string[] = Object.freeze(['production', 'staging']);
export class SmsProviderNotDeliverableError extends Error {
  constructor(environment: string, provider: SmsProviderName) {
    super(
      `SMS provider "${provider}" delivers nothing and cannot be used in ${environment}. ` +
        'Set SMS_PROVIDER to a real gateway and configure its credentials.',
    );
    this.name = 'SmsProviderNotDeliverableError';
  }
}
export interface NotificationConfig {
  smsProvider: SmsProviderName;
  otpTemplateId?: string;
  msg91: {
    authKey: string;
    senderId?: string;
    timeoutMs: number;
  } | null;
}
export function resolveSmsProviderName(
  environment: string,
  explicit: string | undefined,
): SmsProviderName {
  const selected = (explicit ?? '') as SmsProviderName;
  const smsProvider: SmsProviderName = selected
    ? selected
    : DELIVERY_REQUIRED_ENVIRONMENTS.includes(environment)
      ? 'msg91'
      : 'mock';
  if (
    DELIVERY_REQUIRED_ENVIRONMENTS.includes(environment) &&
    NON_DELIVERING_PROVIDERS.includes(smsProvider)
  ) {
    throw new SmsProviderNotDeliverableError(environment, smsProvider);
  }
  return smsProvider;
}
export function getNotificationConfig(): NotificationConfig {
  const smsProvider = resolveSmsProviderName(config.app.environment, process.env.SMS_PROVIDER);
  const authKey = process.env.MSG91_AUTH_KEY;
  const senderId = process.env.MSG91_SENDER_ID;
  const timeoutMs = Number(process.env.SMS_TIMEOUT_MS ?? 5000);
  const msg91 = authKey ? { authKey, timeoutMs, ...(senderId ? { senderId } : {}) } : null;
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
