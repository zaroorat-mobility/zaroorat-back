import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RIDE_EVENT_CATALOG } from '@modules/rides/events/catalog.js';
import { FiscalDocumentService } from '../services/fiscal-document.service.js';

/// Phase 6 (M-09) outbox consumer: issues immutable gapless fiscal documents on `ride.completed`.
/// Strictly gated behind `documents.issue` (default OFF) and idempotent under at-least-once delivery.
export class FiscalDocumentRideCompletedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly fiscalDocumentService: FiscalDocumentService,
  ) {}

  register(): Unsubscribe {
    return this.eventBus.on(RIDE_EVENT_CATALOG.COMPLETED, (e) => this.onRideCompleted(e));
  }

  private async onRideCompleted(envelope: EventEnvelope): Promise<void> {
    const { rideId } = envelope.data as { rideId?: string };
    if (!rideId) return;
    try {
      await this.fiscalDocumentService.issueForCompletedRide(rideId);
    } catch (err) {
      logger.error({ err, rideId }, '[fiscal-document] ride.completed issuance failed');
    }
  }
}
