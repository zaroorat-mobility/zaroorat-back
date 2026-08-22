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
  defaultSearchRadiusKm: Number(process.env.RIDE_SEARCH_RADIUS_KM ?? 5),
  dispatchTimeoutSeconds: Number(process.env.RIDE_DISPATCH_TIMEOUT_SEC ?? 30),
  requestExpiryMinutes: Number(process.env.RIDE_REQUEST_EXPIRY_MIN ?? 5),
  requireStartOtp: process.env.RIDE_REQUIRE_START_OTP !== 'false',
  cancellationGraceMinutes: Number(process.env.RIDE_CANCELLATION_GRACE_MIN ?? 2),
  defaultCancellationFee: Number(process.env.RIDE_DEFAULT_CANCELLATION_FEE ?? 50),
  defaultRateCard,
});
