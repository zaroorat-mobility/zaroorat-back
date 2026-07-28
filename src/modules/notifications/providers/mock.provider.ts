import { randomUUID } from 'node:crypto';
import { logger } from '@shared/logger/index.js';
import type { SmsMessage, SmsProvider, SmsSendResult } from './sms.provider';

/**
 * No-op SMS provider for development and test.
 *
 * Always "accepts" and never performs network I/O. It is registered only in
 * non-production environments, so logging the message payload (including an OTP
 * code) at debug level is a deliberate developer convenience — it lets a
 * developer read the code without a live SMS. It must never be selected in
 * production (enforced by the provider factory).
 */
export class MockProvider implements SmsProvider {
  readonly name = 'mock';

  /**
   * Pretend to deliver an SMS; log it and return a synthetic reference.
   * @param message The message that would have been sent.
   * @returns An always-accepted result with a `mock-…` reference.
   */
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
