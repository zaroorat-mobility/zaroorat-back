import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';
export class RideRequestedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly dispatchService: DispatchService,
  ) {}
  register(): Unsubscribe {
    return this.eventBus.on(RIDE_EVENT_CATALOG.REQUESTED, (envelope) => this.handle(envelope));
  }
  /// The first dispatch round for a new request. Everything that used to live
  /// here — re-reading the request, checking it is still dispatchable, finding a
  /// candidate, offering, promoting CREATED to SEARCHING — is now
  /// `DispatchService.dispatchNextBatch`, shared with the timeout job and the
  /// reject path so all three rounds behave identically. Outbox delivery is
  /// at-least-once, and that method is idempotent under redelivery.
  private async handle(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { requestId?: string };
    if (!data.requestId) {
      logger.warn(
        { eventId: envelope.eventId, type: envelope.type },
        '[rides] ride.requested event carried no requestId',
      );
      return;
    }
    const offered = await this.dispatchService.dispatchNextBatch(data.requestId);
    if (offered === 0) {
      logger.info(
        { requestId: data.requestId },
        '[rides] no live eligible driver candidates near pickup for this request',
      );
    }
  }
}
