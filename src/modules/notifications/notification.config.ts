import { config } from '@config';
import { MockProvider } from './providers/mock.provider';
import { AirtelProvider } from '../../integrations/airtel/airtel.client.js';
import { MockPushProvider } from './providers/mock-push.provider';
import { FcmPushProvider } from '../../integrations/firebase/fcm-push.provider.js';
import { initFcmApp } from '../../integrations/firebase/fcm-app.js';
import type { SmsProvider } from './providers/sms.provider';
import type { PushProvider } from './providers/push.provider';
import type { DeviceRepository } from '../auth/repositories/device.repository.js';
export type SmsProviderName = 'mock' | 'airtel';
export type PushProviderName = 'mock' | 'fcm';
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
  airtel: {
    apiKey?: string;
    username?: string;
    password?: string;
    customerId?: string;
    senderId?: string;
    entityId?: string;
    apiUrl?: string;
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
      ? 'airtel'
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
/// Resolves which push provider to boot for the given environment.
///
/// Rules:
/// - 'fcm' is allowed in any environment and is required in delivery-required ones.
/// - 'mock' is allowed only in non-delivery-required environments.
/// - Any other value is a configuration error in every environment.
/// - If no PUSH_PROVIDER is set, delivery-required environments throw
///   PushProviderNotDeliverableError (same guard as before, now only triggered
///   when the resolved provider is still 'mock').
export function resolvePushProviderName(
  environment: string,
  explicit: string | undefined,
): PushProviderName {
  if (explicit && explicit !== 'mock' && explicit !== 'fcm') {
    throw new Error(
      `PUSH_PROVIDER "${explicit}" is not implemented. ` +
        'Supported values: "fcm" (production), "mock" (development/test only).',
    );
  }
  const provider: PushProviderName = explicit === 'fcm' ? 'fcm' : 'mock';
  if (DELIVERY_REQUIRED_ENVIRONMENTS.includes(environment) && provider === 'mock') {
    throw new PushProviderNotDeliverableError(environment, 'mock');
  }
  return provider;
}
export function getNotificationConfig(): NotificationConfig {
  const smsProvider = resolveSmsProviderName(config.app.environment, process.env.SMS_PROVIDER);
  const apiKey = process.env.AIRTEL_API_KEY;
  const username = process.env.AIRTEL_USERNAME;
  const password = process.env.AIRTEL_PASSWORD;
  const customerId = process.env.AIRTEL_CUSTOMER_ID;
  const senderId = process.env.AIRTEL_SENDER_ID;
  const entityId = process.env.AIRTEL_ENTITY_ID;
  const apiUrl = process.env.AIRTEL_API_URL;
  const timeoutMs = Number(process.env.SMS_TIMEOUT_MS ?? 5000);
  const hasAuth = Boolean(
    (apiKey && apiKey.trim()) || (username && username.trim() && password && password.trim()),
  );
  const airtel = hasAuth
    ? {
        ...(apiKey ? { apiKey } : {}),
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        timeoutMs,
        ...(apiUrl ? { apiUrl } : {}),
        ...(customerId ? { customerId } : {}),
        ...(senderId ? { senderId } : {}),
        ...(entityId ? { entityId } : {}),
      }
    : null;
  const pushProvider = resolvePushProviderName(config.app.environment, process.env.PUSH_PROVIDER);
  return {
    smsProvider,
    airtel,
    pushProvider,
    ...(process.env.AIRTEL_OTP_TEMPLATE_ID
      ? { otpTemplateId: process.env.AIRTEL_OTP_TEMPLATE_ID }
      : {}),
  };
}
export function createSmsProvider(notificationConfig: NotificationConfig): SmsProvider {
  if (notificationConfig.smsProvider === 'airtel') {
    if (!notificationConfig.airtel) {
      throw new Error(
        'SMS provider "airtel" selected but Airtel credentials (AIRTEL_API_KEY or AIRTEL_USERNAME + AIRTEL_PASSWORD) are not configured',
      );
    }
    return new AirtelProvider(notificationConfig.airtel);
  }
  return new MockProvider();
}
export function createPushProvider(
  notificationConfig: NotificationConfig,
  deviceRepository: DeviceRepository,
): PushProvider {
  if (notificationConfig.pushProvider === 'fcm') {
    return new FcmPushProvider(initFcmApp(), deviceRepository);
  }
  return new MockPushProvider();
}
