import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RIDE_EVENT_CATALOG } from '@modules/rides/events/catalog.js';
import { ReceiptService } from '@modules/rides/services/receipt/receipt.service.js';
import { RideCollectionService } from '../services/collection/collection.service.js';

/// Turns a completed ride into a collection attempt.
///
/// It runs off the outbox rather than inside `completeRide` on purpose: a
/// gateway call must not sit inside the completion transaction, and a decline
/// must never be able to un-complete a ride the driver has finished driving
/// (FR-014).
export class RideCollectionConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly rideCollectionService: RideCollectionService,
    private readonly receiptService: ReceiptService,
  ) {}

  register(): Unsubscribe {
    return this.eventBus.on(RIDE_EVENT_CATALOG.COMPLETED, (e) => this.onRideCompleted(e));
  }

  private async onRideCompleted(envelope: EventEnvelope): Promise<void> {
    // From `envelope.data`, not `aggregateId` or `subject.userId`:
    // `buildEnvelope` drops the aggregate id, and ride events carry no subject
    // user. Reading either would silently see `undefined` on every delivery.
    const { rideId } = envelope.data as { rideId?: string };
    if (!rideId) return;
    try {
      // Safe to replay. The service claims the payment status conditionally,
      // so a redelivered envelope finds the obligation already settled and
      // does nothing.
      const result = await this.rideCollectionService.collect(rideId);
      // A cash ride with BD-5's flag off is already PAID when it completes, so
      // collection has nothing to do and never reaches the code that issues a
      // receipt. It still needs one (FR-023). Idempotent, so the rides that
      // did collect are unaffected.
      if (result === 'NOT_COLLECTABLE' || result === 'ALREADY_SETTLED') {
        await this.receiptService.generateReceipt(rideId);
      }
      logger.info({ rideId, result }, '[payments] ride collection attempted');
    } catch (err) {
      // Swallowed deliberately: the relay must not stall the whole outbox on
      // one ride, and the sweep will pick this up again.
      logger.error({ err, rideId }, '[payments] ride collection failed unexpectedly');
    }
  }
}
