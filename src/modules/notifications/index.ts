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

export function registerNotificationModule(container: AwilixContainer): void {
  container.register({
    notificationConfig: asFunction(getNotificationConfig).singleton(),
    smsProvider: asFunction(createSmsProvider).singleton(),
    notificationService: asClass(NotificationService).singleton(),
  });
}
