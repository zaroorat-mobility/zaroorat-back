import { numericEnv } from '../env/numeric.js';

export interface RideConfig {
  dispatchTimeoutSeconds: number;

  dispatchBatchSize: number;
  requestExpiryMinutes: number;
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
  cancellationGraceMinutes: numericEnv('RIDE_CANCELLATION_GRACE_MIN', 2, { min: 0 }),

  defaultCancellationFee: numericEnv('RIDE_DEFAULT_CANCELLATION_FEE', 50, { min: 0 }),
});
