import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { RideRequestRepository } from '../repositories/ride-request.repository.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import { MatchingService } from '../services/dispatch/matching.service.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';
export class RideRequestedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly requestRepo: RideRequestRepository,
    private readonly dispatchService: DispatchService,
    private readonly matchingService: MatchingService,
  ) {}
  register(): Unsubscribe {
    return this.eventBus.on(RIDE_EVENT_CATALOG.REQUESTED, (envelope) => this.handle(envelope));
  }
  private async handle(envelope: EventEnvelope): Promise<void> {
    const data = envelope.data as { requestId?: string };
    if (!data.requestId) {
      logger.warn(
        { eventId: envelope.eventId, type: envelope.type },
        '[rides] ride.requested event carried no requestId',
      );
      return;
    }
    const request = await this.requestRepo.findById(data.requestId);
    if (!request) {
      logger.warn(
        { eventId: envelope.eventId, requestId: data.requestId },
        '[rides] ride.requested event referenced a request that no longer exists',
      );
      return;
    }
    if (!['CREATED', 'SEARCHING'].includes(request.status)) {
      // Already matched, cancelled, or expired by the time this event was
      // delivered (outbox delivery is at-least-once and not instantaneous) —
      // nothing to dispatch.
      return;
    }
    const candidate = await this.matchingService.findNextEligibleCandidate(
      { latitude: Number(request.pickupLat), longitude: Number(request.pickupLng) },
      [],
    );
    if (!candidate) {
      logger.info(
        { requestId: request.id },
        '[rides] no live eligible driver candidates near pickup for this request',
      );
      return;
    }
    try {
      await this.dispatchService.offerToDriver({
        requestId: request.id,
        driverId: candidate.driverId,
        driverDistanceM: Math.round(candidate.distanceMeters),
        dispatchRound: 1,
      });
    } catch (err) {
      // Most likely an at-least-once redelivery racing a prior offer to the
      // same driver for the same request (unique on [requestId, driverId]).
      logger.warn(
        { err, requestId: request.id, driverId: candidate.driverId },
        '[rides] failed to offer the first candidate',
      );
      return;
    }
    if (request.status === 'CREATED') {
      await this.requestRepo.updateStatus(request.id, 'SEARCHING');
    }
  }
}
