import { numericEnv } from '../env/numeric.js';

export interface PricingRateCard {
  baseFare: number;
  perKm: number;
  perMinute: number;
  perWaitingMinute: number;
  freeWaitingMin: number;
  bookingFee: number;
  platformFeePct: number;
  platformFeeFlat: number;
  taxRatePct: number;
  commissionRatePct: number;
  minimumFare: number;
  nightMultiplier: number;
}

export interface PricingConfig {
  defaultRateCard: PricingRateCard;
}

const defaultRateCard: PricingRateCard = Object.freeze({
  baseFare: numericEnv('RIDE_BASE_FARE', 50, { min: 0 }),
  perKm: numericEnv('RIDE_RATE_PER_KM', 12, { min: 0 }),
  perMinute: numericEnv('RIDE_RATE_PER_MIN', 2, { min: 0 }),
  perWaitingMinute: numericEnv('RIDE_RATE_PER_WAIT_MIN', 3, { min: 0 }),
  freeWaitingMin: numericEnv('RIDE_FREE_WAITING_MIN', 3, { min: 0 }),
  bookingFee: numericEnv('RIDE_BOOKING_FEE', 0, { min: 0 }),
  platformFeePct: numericEnv('RIDE_PLATFORM_FEE_PCT', 0, { min: 0, max: 100 }),
  platformFeeFlat: numericEnv('RIDE_PLATFORM_FEE', 15, { min: 0 }),
  taxRatePct: numericEnv('RIDE_TAX_RATE', 0.05, { min: 0, max: 1 }) * 100,
  commissionRatePct: numericEnv('RIDE_COMMISSION_RATE', 0.2, { min: 0, max: 1 }) * 100,
  minimumFare: numericEnv('RIDE_MINIMUM_FARE', 50, { min: 0 }),
  nightMultiplier: 1,
});

export const pricingConfig: PricingConfig = Object.freeze({
  defaultRateCard,
});
