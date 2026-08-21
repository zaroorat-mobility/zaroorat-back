import { randomUUID } from 'node:crypto';
import { config } from '@config';
import { logger } from '@shared/logger/index.js';
import type { PushMessage, PushProvider, PushSendResult } from './push.provider';
/// The only push provider that exists today (see the platform audit's P1
/// finding: FCM tokens were collected and stored but never sent anywhere).
/// This does not reach a device — it makes the call sites real so that a real
/// provider (FCM, APNs) can be dropped in later behind `createPushProvider`
/// exactly the way `Msg91Provider` already sits behind `createSmsProvider`,
/// without touching any of the code that decides *when* to notify.
export class MockPushProvider implements PushProvider {
  readonly name = 'mock';
  async sendPush(message: PushMessage): Promise<PushSendResult> {
    const providerRef = `mock-${randomUUID()}`;
    logger.info(
      { tokenSuffix: message.to.slice(-8), providerRef, provider: this.name, title: message.title },
      '[MockPush] accepted',
    );
    if (config.app.environment === 'development') {
      logger.debug(
        { devPushBody: message.body, data: message.data },
        '[MockPush] payload (development only)',
      );
    }
    return { accepted: true, provider: this.name, providerRef };
  }
}
