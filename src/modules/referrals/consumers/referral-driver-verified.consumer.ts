import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { DRIVER_EVENT_CATALOG } from '@modules/drivers/events/catalog.js';
import { ReferralRuntimeService } from '../referral-runtime.service.js';

export class ReferralDriverVerifiedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly referralRuntimeService: ReferralRuntimeService,
  ) {}

  register(): Unsubscribe {
    return this.eventBus.on(DRIVER_EVENT_CATALOG.VERIFIED, (e) => this.onDriverVerified(e));
  }

  private async onDriverVerified(envelope: EventEnvelope): Promise<void> {
    const { userId } = envelope.data as { userId?: string };
    if (!userId) return;
    try {
      await this.referralRuntimeService.handleDriverVerified(userId);
    } catch (err) {
      logger.error({ err, userId }, '[referral] driver.verified handler failed');
    }
  }
}
