import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RIDE_EVENT_CATALOG } from '@modules/rides/events/catalog.js';
import { ReferralRuntimeService } from '../referral-runtime.service.js';

export class ReferralRideCompletedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly referralRuntimeService: ReferralRuntimeService,
  ) {}

  register(): Unsubscribe {
    return this.eventBus.on(RIDE_EVENT_CATALOG.COMPLETED, (e) => this.onRideCompleted(e));
  }

  private async onRideCompleted(envelope: EventEnvelope): Promise<void> {
    const { rideId } = envelope.data as { rideId?: string };
    if (!rideId) return;
    try {
      await this.referralRuntimeService.handleRideCompleted(rideId);
    } catch (err) {
      logger.error({ err, rideId }, '[referral] ride.completed handler failed');
    }
  }
}
