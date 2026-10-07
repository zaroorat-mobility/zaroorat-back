import type { ArrivalDetectionService } from '@modules/rides/services/arrival/arrival-detection.service.js';
import { driverConfig, rideConfig } from '@config';
import { logger } from '@shared/logger/index.js';
import {
  DriverLocationRepository,
  UpdateDriverLocationInput,
} from '../../repositories/driver-location.repository.js';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverStatusRepository } from '../../repositories/driver-status.repository.js';
import {
  DriverNotFoundError,
  ImplausibleLocationError,
  MockLocationRejectedError,
} from '../../errors/driver.errors.js';
import { DriverMetrics } from '../../metrics/driver.metrics.js';
import { GeoService, haversineKm } from '@modules/location';
import { haversineMeters } from '@modules/location/utils/coordinate.util.js';
import { assessPlausibility } from './location-plausibility.js';
import { RedisService } from '@core/cache/RedisService.js';
import { RedisKeys } from '@core/cache/keys.js';
import { EventPublisher } from '@core/events';
import { RideRepository } from '@modules/rides/repositories/ride.repository.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '@modules/rides/events/catalog.js';
import type { DriverLocation } from '../../types';

export class LocationService {
  constructor(
    private readonly locationRepo: DriverLocationRepository,
    private readonly driverRepo: DriverRepository,
    private readonly statusRepo: DriverStatusRepository,
    private readonly driverMetrics: DriverMetrics,
    private readonly geoService: GeoService,
    private readonly redisService: RedisService,
    private readonly rideRepository: RideRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly arrivalDetectionService?: ArrivalDetectionService,
  ) {}

  async updateLocation(input: UpdateDriverLocationInput): Promise<DriverLocation> {
    if (input.isMockLocation === true && driverConfig.rejectMockLocation) {
      this.driverMetrics.mockLocationRejected({ driverId: input.driverId });
      throw new MockLocationRejectedError();
    }
    const driver = await this.driverRepo.findById(input.driverId);
    if (!driver) throw new DriverNotFoundError(input.driverId);
    const previous = await this.locationRepo.getLocation(input.driverId);
    const verdict = assessPlausibility(
      { latitude: input.latitude, longitude: input.longitude },
      previous
        ? {
            latitude: Number(previous.latitude),
            longitude: Number(previous.longitude),
            recordedAt: previous.recordedAt,
          }
        : null,
    );
    if (!verdict.plausible) {
      this.driverMetrics.implausibleLocationRejected({
        driverId: input.driverId,
        reason: verdict.reason,
      });
      logger.warn(
        { driverId: input.driverId, reason: verdict.reason, detail: verdict.detail },
        '[drivers] implausible location rejected',
      );
      throw new ImplausibleLocationError(verdict.reason, verdict.detail);
    }
    const location = await this.locationRepo.updateLocation(input);
    this.driverMetrics.locationUpdated({ driverId: input.driverId });
    await this.accrueTripDistance(input, previous);
    if (
      driver.verificationStatus === 'VERIFIED' &&
      !driver.isSuspended &&
      driver.isAvailable === true
    ) {
      await this.geoService.recordDriverPosition({
        driverId: input.driverId,
        latitude: input.latitude,
        longitude: input.longitude,
        recordedAt: location.recordedAt,
      });
    }
    await this.statusRepo.updateHeartbeat(input.driverId);
    await this.maybeNotifyDriverNearby(input);
    if (this.arrivalDetectionService) {
      try {
        await this.arrivalDetectionService.evaluateFix({
          driverId: input.driverId,
          latitude: input.latitude,
          longitude: input.longitude,
          accuracyMeters: input.accuracyMeters,
          isMockLocation: input.isMockLocation,
          recordedAt: location.recordedAt,
        });
      } catch (err) {
        logger.warn(
          { err, driverId: input.driverId },
          '[drivers] arrival detection evaluation failed',
        );
      }
    }
    return location;
  }

  /// One-shot "driver is nearby" when an en-route driver enters the nearby radius.
  private async maybeNotifyDriverNearby(input: UpdateDriverLocationInput): Promise<void> {
    try {
      const ride = await this.rideRepository.findActiveByDriver(input.driverId);
      if (!ride) return;
      if (ride.status !== 'ACCEPTED' && ride.status !== 'DRIVER_ARRIVING') return;
      const request = (
        ride as {
          request?: {
            pickupLat?: unknown;
            pickupLng?: unknown;
          };
        }
      ).request;
      if (request?.pickupLat == null || request?.pickupLng == null) return;
      const distance = haversineMeters(
        input.latitude,
        input.longitude,
        Number(request.pickupLat),
        Number(request.pickupLng),
      );
      if (distance > rideConfig.driverNearbyMeters) return;

      const key = RedisKeys.driverNearbySent(ride.id);
      const client = this.redisService.provider.client;
      const set = await client.set(key, '1', 'EX', 60 * 60 * 6, 'NX');
      if (set !== 'OK') return;

      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.DRIVER_NEARBY, ride.customerId, {
          rideId: ride.id,
          driverId: input.driverId,
          distanceMeters: Math.round(distance),
        }),
      );
    } catch (err) {
      logger.warn(
        { err, driverId: input.driverId },
        '[drivers] could not evaluate driver-nearby notification',
      );
    }
  }

  /// Moves the trip meter by the distance since the last fix.
  ///
  /// This is what stops a ride's fare being whatever number the driver's app
  /// puts in the completion request. The server adds up the journey from the
  /// fixes the app is already sending, and `LifecycleService.completeRide`
  /// bills on that rather than on the client's claim.
  ///
  /// Accumulated for every fix, not just in-trip ones, and deliberately so: the
  /// counter is reset when a trip starts and read when it ends, so only the
  /// movement between those two points can ever reach a fare. That keeps this
  /// endpoint from having to resolve which ride a driver is on — and a
  /// client-supplied `rideId` must never decide it, because the fare depends on
  /// it.
  ///
  /// Never allowed to fail a location update. A dropped fix costs a little
  /// measured distance, and `max(measured, quoted)` means the fare falls back
  /// towards the quote rather than to nothing.
  private async accrueTripDistance(
    input: UpdateDriverLocationInput,
    previous: DriverLocation | null,
  ): Promise<void> {
    if (!previous || previous.latitude == null || previous.longitude == null) return;
    // A fix that does not know where it is cannot be trusted to move the meter.
    if (
      input.accuracyMeters != null &&
      input.accuracyMeters > rideConfig.distanceMaxAccuracyMeters
    ) {
      return;
    }
    const km = haversineKm(
      Number(previous.latitude),
      Number(previous.longitude),
      input.latitude,
      input.longitude,
    );
    // Below the floor this is jitter, not travel: a parked car with a noisy
    // fix would otherwise earn kilometres for standing still.
    if (km * 1000 < rideConfig.distanceNoiseFloorMeters) return;
    try {
      await this.redisService.tripDistance.add(input.driverId, km);
    } catch (err) {
      logger.warn(
        { err, driverId: input.driverId },
        '[drivers] could not add to the trip distance meter',
      );
    }
  }

  async getLocation(driverId: string): Promise<DriverLocation | null> {
    return this.locationRepo.getLocation(driverId);
  }
}
