import { numericEnv } from '../env/numeric.js';

export interface RideConfig {
  dispatchTimeoutSeconds: number;
  dispatchBatchSize: number;
  requestExpiryMinutes: number;
  /// Driver must be within this distance of pickup to mark arrived.
  pickupGeofenceMeters: number;
  /// Driver must be within this distance of drop to complete (unless early-end reason).
  dropGeofenceMeters: number;
  /// Maximum GPS accuracy (in meters) acceptable for arrival confirmation.
  arrivalMaxAccuracyMeters: number;
  /// Number of consecutive valid fixes inside radius required to confirm arrival.
  arrivalRequiredFixes: number;
  /// Maximum age in ms for an arrival fix to be trusted.
  arrivalMaxFixAgeMs: number;
  /// Maximum dispatch search rounds before expiring the request.
  dispatchMaxRounds: number;
  /// Maximum total unique drivers attempted before expiring the request.
  dispatchMaxAttemptedDrivers: number;
  /// Fire a one-shot "driver nearby" push when the driver is this close to pickup.
  driverNearbyMeters: number;
  /// A location hop shorter than this is GPS jitter, not travel, and must not
  /// accrue billable distance while a car sits at lights.
  distanceNoiseFloorMeters: number;
  /// A fix reporting worse accuracy than this is not trusted to move the meter.
  distanceMaxAccuracyMeters: number;
  cancellationGraceMinutes: number;
  defaultCancellationFee: number;
  /// Earliest a scheduled pickup may be booked, measured from now.
  scheduledMinLeadMinutes: number;
  /// Public trip-tracking link: `${shareBaseUrl}/${token}`.
  shareBaseUrl: string;
  shareTokenTtlHours: number;
}

export const rideConfig: RideConfig = Object.freeze({
  dispatchTimeoutSeconds: numericEnv('RIDE_DISPATCH_TIMEOUT_SEC', 10, { min: 1, integer: true }),
  dispatchBatchSize: numericEnv('RIDE_DISPATCH_BATCH_SIZE', 3, {
    min: 1,
    max: 20,
    integer: true,
  }),
  requestExpiryMinutes: numericEnv('RIDE_REQUEST_EXPIRY_MIN', 5, { min: 1 }),
  pickupGeofenceMeters: numericEnv('RIDE_PICKUP_GEOFENCE_M', 100, { min: 10 }),
  dropGeofenceMeters: numericEnv('RIDE_DROP_GEOFENCE_M', 100, { min: 10 }),
  arrivalMaxAccuracyMeters: numericEnv('RIDE_ARRIVAL_MAX_ACCURACY_M', 50, { min: 1 }),
  arrivalRequiredFixes: numericEnv('RIDE_ARRIVAL_REQUIRED_FIXES', 3, { min: 1, integer: true }),
  arrivalMaxFixAgeMs: numericEnv('RIDE_ARRIVAL_MAX_FIX_AGE_MS', 30000, { min: 1000 }),
  dispatchMaxRounds: numericEnv('RIDE_DISPATCH_MAX_ROUNDS', 5, { min: 1, integer: true }),
  dispatchMaxAttemptedDrivers: numericEnv('RIDE_DISPATCH_MAX_ATTEMPTED_DRIVERS', 20, {
    min: 1,
    integer: true,
  }),
  driverNearbyMeters: numericEnv('RIDE_DRIVER_NEARBY_M', 500, { min: 50 }),
  distanceNoiseFloorMeters: numericEnv('RIDE_DISTANCE_NOISE_FLOOR_M', 20, { min: 0 }),
  distanceMaxAccuracyMeters: numericEnv('RIDE_DISTANCE_MAX_ACCURACY_M', 50, { min: 1 }),
  cancellationGraceMinutes: numericEnv('RIDE_CANCELLATION_GRACE_MIN', 2, { min: 0 }),
  defaultCancellationFee: numericEnv('RIDE_DEFAULT_CANCELLATION_FEE', 50, { min: 0 }),
  scheduledMinLeadMinutes: numericEnv('RIDE_SCHEDULED_MIN_LEAD_MIN', 30, { min: 0 }),
  shareBaseUrl: (process.env.RIDE_SHARE_BASE_URL ?? 'https://zaroorat.app/track').replace(
    /\/+$/,
    '',
  ),
  shareTokenTtlHours: numericEnv('RIDE_SHARE_TOKEN_TTL_HOURS', 12, { min: 1 }),
});
