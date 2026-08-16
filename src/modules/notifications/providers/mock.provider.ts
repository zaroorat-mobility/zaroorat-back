import { randomUUID } from 'node:crypto';
import { config } from '@config';
import { logger } from '@shared/logger/index.js';
import { maskPhone } from '@shared/validation';
import type { SmsMessage, SmsProvider, SmsSendResult } from './sms.provider';
export class MockProvider implements SmsProvider {
  readonly name = 'mock';
  async sendSms(message: SmsMessage): Promise<SmsSendResult> {
    const providerRef = `mock-${randomUUID()}`;
    logger.info(
      { recipient: maskPhone(message.to), providerRef, provider: this.name },
      '[MockSMS] accepted',
    );
    if (config.app.environment === 'development') {
      logger.debug(
        { recipient: maskPhone(message.to), devSmsBody: message.body },
        '[MockSMS] payload (development only)',
      );
    }
    return { accepted: true, provider: this.name, providerRef };
  }
}
