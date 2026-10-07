import { logger } from '@shared/logger/index.js';
import { rideConfig } from '@config';
import { haversineMeters } from '@modules/location/utils/coordinate.util.js';
import { RedisKeys } from '@core/cache/keys.js';
import type { RedisService } from '@core/cache/RedisService.js';
import type { RideRepository } from '../../repositories/ride.repository.js';
import type { LifecycleService } from '../lifecycle/lifecycle.service.js';

export interface LocationFixInput {
  driverId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null | undefined;
  isMockLocation?: boolean | undefined;
  recordedAt?: Date | string | number | null | undefined;
}

export interface ArrivalEvaluationResult {
  evaluated: boolean;
  target?: 'pickup' | 'drop';
  distanceMeters?: number;
  consecutiveFixes?: number;
  transitioned?: boolean;
  reason?: string;
}

export class ArrivalDetectionService {
  constructor(
    private readonly rideRepository: RideRepository,
    private readonly lifecycleService: LifecycleService,
    private readonly redisService: RedisService,
  ) {}

  async evaluateFix(input: LocationFixInput, now = Date.now()): Promise<ArrivalEvaluationResult> {
    // 1. Reject mock locations
    if (input.isMockLocation) {
      return { evaluated: false, reason: 'MOCK_LOCATION' };
    }

    // 2. Reject missing or invalid accuracy
    if (input.accuracyMeters == null || !Number.isFinite(Number(input.accuracyMeters))) {
      return { evaluated: false, reason: 'MISSING_ACCURACY' };
    }

    // 3. Reject low-accuracy fixes beyond allowed threshold
    if (Number(input.accuracyMeters) > rideConfig.arrivalMaxAccuracyMeters) {
      return { evaluated: false, reason: 'LOW_ACCURACY' };
    }

    // 4. Reject stale or future fixes
    if (input.recordedAt != null) {
      const recordedAtMs =
        input.recordedAt instanceof Date
          ? input.recordedAt.getTime()
          : typeof input.recordedAt === 'number'
            ? input.recordedAt
            : Date.parse(input.recordedAt);

      if (Number.isNaN(recordedAtMs)) {
        return { evaluated: false, reason: 'INVALID_TIMESTAMP' };
      }
      if (now - recordedAtMs > rideConfig.arrivalMaxFixAgeMs) {
        return { evaluated: false, reason: 'STALE_FIX' };
      }
      if (recordedAtMs > now + rideConfig.arrivalMaxFixAgeMs) {
        return { evaluated: false, reason: 'FUTURE_FIX' };
      }
    }

    // 5. Find active ride for driver
    const ride = await this.rideRepository.findActiveByDriver(input.driverId);
    if (!ride) {
      return { evaluated: false, reason: 'NO_ACTIVE_RIDE' };
    }

    let target: 'pickup' | 'drop';
    let targetLat: number | null;
    let targetLng: number | null;
    let radiusMeters: number;

    const req = (
      ride as {
        request?: {
          pickupLat?: unknown;
          pickupLng?: unknown;
          dropLat?: unknown;
          dropLng?: unknown;
        };
      }
    ).request;

    if (ride.status === 'ACCEPTED' || ride.status === 'DRIVER_ARRIVING') {
      target = 'pickup';
      targetLat = req?.pickupLat != null ? Number(req.pickupLat) : null;
      targetLng = req?.pickupLng != null ? Number(req.pickupLng) : null;
      radiusMeters = rideConfig.pickupGeofenceMeters;
    } else if (ride.status === 'IN_PROGRESS') {
      target = 'drop';
      targetLat = req?.dropLat != null ? Number(req.dropLat) : null;
      targetLng = req?.dropLng != null ? Number(req.dropLng) : null;
      radiusMeters = rideConfig.dropGeofenceMeters;
    } else {
      return { evaluated: false, reason: 'STATUS_NOT_AWAITING_ARRIVAL' };
    }

    if (
      targetLat == null ||
      targetLng == null ||
      !Number.isFinite(targetLat) ||
      !Number.isFinite(targetLng)
    ) {
      return { evaluated: false, reason: 'MISSING_TARGET_COORDINATES' };
    }

    const distanceMeters = haversineMeters(input.latitude, input.longitude, targetLat, targetLng);
    const client = this.redisService.provider.client;
    const fixKey = RedisKeys.arrivalFixCount(ride.id, target);

    if (distanceMeters <= radiusMeters) {
      const count = await client.incr(fixKey);
      await client.expire(fixKey, 300);

      if (count >= rideConfig.arrivalRequiredFixes) {
        const lockKey = RedisKeys.arrivalLock(ride.id, target);
        const lockAcquired = await client.set(lockKey, '1', 'EX', 60, 'NX');
        if (!lockAcquired) {
          return {
            evaluated: true,
            target,
            distanceMeters,
            consecutiveFixes: count,
            transitioned: false,
            reason: 'LOCKED',
          };
        }

        try {
          if (target === 'pickup') {
            await this.lifecycleService.markDriverArrived(ride.id, input.driverId);
          } else {
            await this.lifecycleService.markDriverArrivedAtDropoff(ride.id, input.driverId);
          }
          await client.del(fixKey);
          return {
            evaluated: true,
            target,
            distanceMeters,
            consecutiveFixes: count,
            transitioned: true,
          };
        } catch (err) {
          logger.warn(
            { err, rideId: ride.id, target },
            '[arrival-detection] could not transition arrival state',
          );
          return {
            evaluated: true,
            target,
            distanceMeters,
            consecutiveFixes: count,
            transitioned: false,
            reason: 'TRANSITION_ERROR',
          };
        }
      }

      return {
        evaluated: true,
        target,
        distanceMeters,
        consecutiveFixes: count,
        transitioned: false,
      };
    } else {
      await client.del(fixKey);
      return {
        evaluated: true,
        target,
        distanceMeters,
        consecutiveFixes: 0,
        transitioned: false,
        reason: 'OUT_OF_RADIUS',
      };
    }
  }
}
