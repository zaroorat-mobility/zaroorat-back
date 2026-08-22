import { numericEnv } from '../env/numeric.js';
export interface RideRateCard {
  baseFare: number;
  perKm: number;
  perMinute: number;
  perWaitingMinute: number;
  platformFee: number;
  commissionRate: number;
  taxRate: number;
  minimumFare: number;
}
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
  /// Platform-wide fallback. Per-category pricing lives on `VehicleType`
  /// columns (base_fare, per_km_rate, per_minute_rate, minimum_fare,
  /// waiting_charge); this fills in any field a type leaves null, plus the
  /// three that have no column at all (platformFee, commissionRate, taxRate).
  ///
  /// The previous `RIDE_RATE_CARDS_JSON` override keyed cards by vehicle-type
  /// UUID from an environment variable, which no operator could populate for
  /// database-generated ids — it was removed rather than left as dead config.
  defaultRateCard: RideRateCard;
}
const defaultRateCard: RideRateCard = Object.freeze({
  baseFare: Number(process.env.RIDE_BASE_FARE ?? 50),
  perKm: Number(process.env.RIDE_RATE_PER_KM ?? 12),
  perMinute: Number(process.env.RIDE_RATE_PER_MIN ?? 2),
  perWaitingMinute: Number(process.env.RIDE_RATE_PER_WAIT_MIN ?? 3),
  platformFee: Number(process.env.RIDE_PLATFORM_FEE ?? 15),
  commissionRate: Number(process.env.RIDE_COMMISSION_RATE ?? 0.2),
  taxRate: Number(process.env.RIDE_TAX_RATE ?? 0.05),
  minimumFare: Number(process.env.RIDE_MINIMUM_FARE ?? 50),
});
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
  defaultRateCard,
});
