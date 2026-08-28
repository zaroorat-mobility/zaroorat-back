import { numericEnv } from '../env/numeric.js';

export interface RideConfig {
  dispatchTimeoutSeconds: number;

  dispatchBatchSize: number;
  requestExpiryMinutes: number;
  /// A location hop shorter than this is GPS jitter, not travel, and must not
  /// accrue billable distance while a car sits at lights. Distinct from
  /// `driverConfig.locationNoiseFloorMeters`, which decides when a hop is big
  /// enough to imply a speed worth sanity-checking — a different question.
  distanceNoiseFloorMeters: number;
  /// A fix reporting worse accuracy than this is not trusted to move the meter.
  distanceMaxAccuracyMeters: number;
  cancellationGraceMinutes: number;
  defaultCancellationFee: number;
}

export const rideConfig: RideConfig = Object.freeze({
  dispatchTimeoutSeconds: numericEnv('RIDE_DISPATCH_TIMEOUT_SEC', 30, { min: 1, integer: true }),

  dispatchBatchSize: numericEnv('RIDE_DISPATCH_BATCH_SIZE', 3, {
    min: 1,
    max: 20,
    integer: true,
  }),
  requestExpiryMinutes: numericEnv('RIDE_REQUEST_EXPIRY_MIN', 5, { min: 1 }),
  distanceNoiseFloorMeters: numericEnv('RIDE_DISTANCE_NOISE_FLOOR_M', 20, { min: 0 }),
  distanceMaxAccuracyMeters: numericEnv('RIDE_DISTANCE_MAX_ACCURACY_M', 50, { min: 1 }),
  cancellationGraceMinutes: numericEnv('RIDE_CANCELLATION_GRACE_MIN', 2, { min: 0 }),

  defaultCancellationFee: numericEnv('RIDE_DEFAULT_CANCELLATION_FEE', 50, { min: 0 }),
});
