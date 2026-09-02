import { asClass, asFunction, AwilixContainer } from 'awilix';
import {
  getNotificationConfig,
  createSmsProvider,
  createPushProvider,
} from './notification.config';
import { NotificationService } from './notification.service';
export type { SmsProvider, SmsMessage, SmsSendResult } from './providers/sms.provider';
export type { PushProvider, PushMessage, PushSendResult } from './providers/push.provider';
export type { EmailProvider, EmailMessage, EmailSendResult } from './providers/email.provider';
export { MockProvider } from './providers/mock.provider';
export { SmtpEmailProvider, type SmtpConfig } from './providers/smtp.provider.js';
export { Msg91Provider, type Msg91Config } from '../../integrations/msg91/msg91.client.js';
export { MockPushProvider } from './providers/mock-push.provider';
export {
  getNotificationConfig,
  createSmsProvider,
  createPushProvider,
  resolveSmsProviderName,
  SmsProviderNotDeliverableError,
  type NotificationConfig,
  type SmsProviderName,
  type PushProviderName,
} from './notification.config';
export { NotificationService, type SendSmsOptions } from './notification.service';
export function registerNotificationModule(container: AwilixContainer): void {
  container.register({
    notificationConfig: asFunction(getNotificationConfig).singleton(),
    smsProvider: asFunction(createSmsProvider).singleton(),
    pushProvider: asFunction(createPushProvider).singleton(),
    notificationService: asClass(NotificationService).singleton(),
  });
}
