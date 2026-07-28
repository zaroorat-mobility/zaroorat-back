import { asClass, asFunction, AwilixContainer } from 'awilix';

import { getNotificationConfig, createSmsProvider } from './notification.config';
import { NotificationService } from './notification.service';

export type { SmsProvider, SmsMessage, SmsSendResult } from './providers/sms.provider';
export { MockProvider } from './providers/mock.provider';
export { Msg91Provider, type Msg91Config } from './providers/msg91.provider';
export {
  getNotificationConfig,
  createSmsProvider,
  type NotificationConfig,
  type SmsProviderName,
} from './notification.config';
export { NotificationService, type SendSmsOptions } from './notification.service';

/**
 * Registers the notification module into the Awilix container.
 *
 * `smsProvider` is a factory registration (CLASSIC injection resolves its
 * `notificationConfig` param by name) that yields the mock or MSG91 provider;
 * `notificationService` depends on `smsProvider` + `notificationConfig`.
 * @param container The application DI container.
 */
export function registerNotificationModule(container: AwilixContainer): void {
  container.register({
    notificationConfig: asFunction(getNotificationConfig).singleton(),
    smsProvider: asFunction(createSmsProvider).singleton(),
    notificationService: asClass(NotificationService).singleton(),
  });
}
