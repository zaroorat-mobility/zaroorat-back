import { numericEnv } from '../env/numeric.js';

export interface PricingRateCard {
  baseFare: number;
  perKm: number;
  perMinute: number;
  perWaitingMinute: number;
  /// FR-012. Minutes of waiting absorbed before `perWaitingMinute` starts
  /// billing. There used to be a second field, `freeWaitingMinutes`, fed from
  /// the same `PricingRule.freeWaitingMin` column but from a different
  /// environment variable — and nothing read it. Two names for one number is how
  /// an operator sets the grace period in the wrong one.
  freeWaitingMin: number;
  bookingFee: number;
  platformFeePct: number;
  platformFeeFlat: number;
  taxRatePct: number;
  commissionRatePct: number;
  minimumFare: number;
}

export interface PricingConfig {
  defaultRateCard: PricingRateCard;
  /// Straight-line distance is multiplied by this to approximate the road
  /// distance. Never below 1: no road is shorter than the line between its
  /// ends. Replacing the estimate with a real routing provider retires it.
  roadDistanceFactor: number;
  /// Minutes allowed per road kilometre — the inverse of an assumed average
  /// city speed. The default of 3 is 20 km/h.
  minutesPerKm: number;
}

const defaultRateCard: PricingRateCard = Object.freeze({
  baseFare: numericEnv('RIDE_BASE_FARE', 50, { min: 0 }),
  perKm: numericEnv('RIDE_RATE_PER_KM', 12, { min: 0 }),
  perMinute: numericEnv('RIDE_RATE_PER_MIN', 2, { min: 0 }),
  perWaitingMinute: numericEnv('RIDE_RATE_PER_WAIT_MIN', 3, { min: 0 }),
  // Mirrors `PricingRule.freeWaitingMin`, whose column default is also 3.
  // `RIDE_FREE_WAIT_MIN` fed the removed duplicate and now has no reader.
  freeWaitingMin: numericEnv('RIDE_FREE_WAITING_MIN', 3, { min: 0 }),
  bookingFee: numericEnv('RIDE_BOOKING_FEE', 0, { min: 0 }),
  platformFeePct: numericEnv('RIDE_PLATFORM_FEE_PCT', 0, { min: 0, max: 100 }),
  platformFeeFlat: numericEnv('RIDE_PLATFORM_FEE', 15, { min: 0 }),
  taxRatePct: numericEnv('RIDE_TAX_RATE', 0.05, { min: 0, max: 1 }) * 100,
  commissionRatePct: numericEnv('RIDE_COMMISSION_RATE', 0.2, { min: 0, max: 1 }) * 100,
  minimumFare: numericEnv('RIDE_MINIMUM_FARE', 50, { min: 0 }),
});

export const pricingConfig: PricingConfig = Object.freeze({
  defaultRateCard,
  // Both were literals inside `estimateTrip` while every other pricing input
  // came from here, so the two numbers that scale every quoted distance and
  // every quoted duration were the only ones an operator could not touch.
  roadDistanceFactor: numericEnv('RIDE_ROAD_DISTANCE_FACTOR', 1.3, { min: 1, max: 3 }),
  minutesPerKm: numericEnv('RIDE_MINUTES_PER_KM', 3, { min: 0.1, max: 60 }),
});
