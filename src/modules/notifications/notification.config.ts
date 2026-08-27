import { config } from '@config';
import { MockProvider } from './providers/mock.provider';
import { Msg91Provider } from './providers/msg91.provider.js';
import { MockPushProvider } from './providers/mock-push.provider';
import type { SmsProvider } from './providers/sms.provider';
import type { PushProvider } from './providers/push.provider';
export type SmsProviderName = 'mock' | 'msg91';
export type PushProviderName = 'mock';
const NON_DELIVERING_PROVIDERS: readonly SmsProviderName[] = Object.freeze(['mock']);
const DELIVERY_REQUIRED_ENVIRONMENTS: readonly string[] = Object.freeze(['production', 'staging']);
export class PushProviderNotDeliverableError extends Error {
  constructor(environment: string, provider: PushProviderName) {
    super(
      `Push provider "${provider}" delivers nothing and cannot be used in ${environment}. ` +
        'It accepts every message and drops it, so a dispatch offer sent to a driver whose ' +
        'app is backgrounded reaches nobody and expires unanswered. Implement a real provider ' +
        'behind createPushProvider and select it with PUSH_PROVIDER before deploying here.',
    );
    this.name = 'PushProviderNotDeliverableError';
  }
}
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
/// Refuses, at boot, to run a delivery-required environment on a push provider
/// that delivers nothing — the same rule `resolveSmsProviderName` applies right
/// above, and the asymmetry between them was the bug.
///
/// This used to warn instead, on the reasoning that no real provider exists yet
/// so there is nothing to select. That reasoning inverted the point: the absence
/// of a provider is exactly what an operator needs to be stopped by, and a
/// single startup log line is not a stop. Every push the platform then emitted
/// was accepted and dropped, silently and forever.
///
/// It matters most for drivers, not riders. A rider whose app is closed misses a
/// status update; a driver whose app is backgrounded never sees the dispatch
/// offer at all, and it expires unanswered while the customer waits. Dispatch
/// only works for drivers holding their phone.
///
/// No override, for the same reason C-1's gateway guard has none: an escape
/// hatch here would be used once, in a hurry, and never removed. Exported and
/// pure so it can be tested against every environment — the running process
/// reads `config.app.environment` once at import.
export function resolvePushProviderName(
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
    throw new PushProviderNotDeliverableError(environment, 'mock');
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
