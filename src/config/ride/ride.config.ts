import { numericEnv } from '../env/numeric.js';

export interface RideConfig {
  defaultSearchRadiusKm: number;
  dispatchTimeoutSeconds: number;
  /// How many drivers are offered the same request in one dispatch round.
  /// 1 restores the original strictly-sequential behaviour. Raising it shortens
  /// time-to-match at the cost of more drivers seeing an offer they will lose.
  dispatchBatchSize: number;
  requestExpiryMinutes: number;
  requireStartOtp: boolean;
  cancellationGraceMinutes: number;
  defaultCancellationFee: number;
}

export const rideConfig: RideConfig = Object.freeze({
  defaultSearchRadiusKm: numericEnv('RIDE_SEARCH_RADIUS_KM', 5, { min: 0.1 }),
  // A zero or negative window would mint offers that are already expired: every
  // accept would fail and the timeout job would re-dispatch on every tick until
  // the request aged out.
  dispatchTimeoutSeconds: numericEnv('RIDE_DISPATCH_TIMEOUT_SEC', 30, { min: 1, integer: true }),
  // The ceiling on how many drivers may hold an offer for one request at once.
  // Capped as well as floored: an operator who fat-fingers a large value should
  // be stopped at boot, not discovered when half the city is paged for one ride.
  dispatchBatchSize: numericEnv('RIDE_DISPATCH_BATCH_SIZE', 3, {
    min: 1,
    max: 20,
    integer: true,
  }),
  requestExpiryMinutes: numericEnv('RIDE_REQUEST_EXPIRY_MIN', 5, { min: 1 }),
  requireStartOtp: process.env.RIDE_REQUIRE_START_OTP !== 'false',
  cancellationGraceMinutes: Number(process.env.RIDE_CANCELLATION_GRACE_MIN ?? 2),
  defaultCancellationFee: Number(process.env.RIDE_DEFAULT_CANCELLATION_FEE ?? 50),
});
