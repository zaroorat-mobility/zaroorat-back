import { randomUUID } from 'node:crypto';
import { logger } from '@shared/logger/index.js';
import type { SmsMessage, SmsProvider, SmsSendResult } from './sms.provider';

export class MockProvider implements SmsProvider {
  readonly name = 'mock';

  async sendSms(message: SmsMessage): Promise<SmsSendResult> {
    const providerRef = `mock-${randomUUID()}`;
    logger.info({ to: message.to, providerRef, provider: this.name }, '[MockSMS] accepted');
    logger.debug(
      { to: message.to, body: message.body, variables: message.variables },
      '[MockSMS] payload (dev only)',
    );
    return { accepted: true, provider: this.name, providerRef };
  }
}
