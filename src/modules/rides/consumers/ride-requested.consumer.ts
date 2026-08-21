import { EventBus, type EventEnvelope, type Unsubscribe } from '@core/events';
import { GeoService } from '@modules/geo';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverStatusRepository } from '@modules/drivers/repositories/driver-status.repository.js';
import { logger } from '@shared/logger/index.js';
import { RideRequestRepository } from '../repositories/ride-request.repository.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import { RIDE_EVENT_CATALOG } from '../events/catalog.js';
/// Dispatch v1: offer the request to the nearest eligible online driver only.
/// There is no retry-to-next-candidate on timeout/reject yet (DispatchTimeoutJob
/// only marks offers TIMEOUT, it does not re-trigger this consumer) — that is
/// tracked as follow-up work, not silently assumed to exist.
const MAX_CANDIDATES_TO_TRY = 1;
export class RideRequestedConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly requestRepo: RideRequestRepository,
    private readonly dispatchService: DispatchService,
    private readonly geoService: GeoService,
    private readonly driverRepository: DriverRepository,
    private readonly driverStatusRepository: DriverStatusRepository,
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
    const nearby = await this.geoService.findNearbyDrivers({
      origin: { latitude: Number(request.pickupLat), longitude: Number(request.pickupLng) },
    });
    if (nearby.outcome === 'no-live-candidates') {
      logger.info(
        { requestId: request.id },
        '[rides] no live driver candidates near pickup for this request',
      );
      return;
    }
    let offered = 0;
    for (const candidate of nearby.drivers) {
      if (offered >= MAX_CANDIDATES_TO_TRY) break;
      const eligible = await this.isEligible(candidate.driverId);
      if (!eligible) continue;
      try {
        await this.dispatchService.offerToDriver({
          requestId: request.id,
          driverId: candidate.driverId,
          driverDistanceM: Math.round(candidate.distanceMeters),
        });
        offered++;
      } catch (err) {
        // Most likely an at-least-once redelivery racing a prior offer to the
        // same driver for the same request (unique on [requestId, driverId]).
        // Don't let one duplicate stop the rest of the candidate list.
        logger.warn(
          { err, requestId: request.id, driverId: candidate.driverId },
          '[rides] failed to offer this candidate, trying the next one',
        );
      }
    }
    if (offered > 0 && request.status === 'CREATED') {
      await this.requestRepo.updateStatus(request.id, 'SEARCHING');
    }
  }
  private async isEligible(driverId: string): Promise<boolean> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver || driver.verificationStatus !== 'VERIFIED' || driver.isSuspended) return false;
    const status = await this.driverStatusRepository.getStatus(driverId);
    return status?.status === 'ONLINE';
  }
}
