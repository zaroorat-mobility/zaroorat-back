import { config } from '@config';
import { logger } from '@shared/logger/index.js';
import { MockProvider } from './providers/mock.provider';
import { Msg91Provider } from './providers/msg91.provider';
import { MockPushProvider } from './providers/mock-push.provider';
import type { SmsProvider } from './providers/sms.provider';
import type { PushProvider } from './providers/push.provider';
export type SmsProviderName = 'mock' | 'msg91';
export type PushProviderName = 'mock';
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
  pushProvider: PushProviderName;
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
/// Unlike SMS, no real push provider exists yet at all (see the platform
/// audit's P1 finding) — there is nothing to select besides 'mock', so this
/// warns rather than throws even in production. The knob still exists so
/// dropping a real provider in later is a config change, not a code change,
/// exactly like SMS's msg91/mock split.
function resolvePushProviderName(
  environment: string,
  explicit: string | undefined,
): PushProviderName {
  if (explicit && explicit !== 'mock') {
    throw new Error(
      `PUSH_PROVIDER "${explicit}" is not implemented — only "mock" exists today. ` +
        'Add a real provider behind createPushProvider before configuring one.',
    );
  }
  if (DELIVERY_REQUIRED_ENVIRONMENTS.includes(environment)) {
    logger.warn(
      { environment },
      '[notifications] no real push provider is configured — push notifications will not reach a device',
    );
  }
  return 'mock';
}
export function getNotificationConfig(): NotificationConfig {
  const smsProvider = resolveSmsProviderName(config.app.environment, process.env.SMS_PROVIDER);
  const authKey = process.env.MSG91_AUTH_KEY;
  const senderId = process.env.MSG91_SENDER_ID;
  const timeoutMs = Number(process.env.SMS_TIMEOUT_MS ?? 5000);
  const msg91 = authKey ? { authKey, timeoutMs, ...(senderId ? { senderId } : {}) } : null;
  const pushProvider = resolvePushProviderName(config.app.environment, process.env.PUSH_PROVIDER);
  return {
    smsProvider,
    msg91,
    pushProvider,
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
export function createPushProvider(): PushProvider {
  return new MockPushProvider();
}
