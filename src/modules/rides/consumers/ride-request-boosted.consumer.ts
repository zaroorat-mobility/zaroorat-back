import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';

/// Re-opens prior offers and tops up with fresh candidates after a fare boost.
export class RideRequestBoostedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly dispatchService: DispatchService,
  ) {}

  register(): Unsubscribe {
    return this.eventBus.on(RIDE_EVENT_CATALOG.REQUEST_BOOSTED, (envelope) =>
      this.handle(envelope),
    );
  }

  private async handle(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { requestId?: string };
    if (!data.requestId) {
      logger.warn(
        { eventId: envelope.eventId, type: envelope.type },
        '[rides] ride.request.boosted event carried no requestId',
      );
      return;
    }
    const result = await this.dispatchService.redispatchAfterBoost(data.requestId);
    logger.info({ requestId: data.requestId, ...result }, '[rides] redispatched after fare boost');
  }
}
