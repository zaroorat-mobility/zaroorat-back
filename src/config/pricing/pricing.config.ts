import { numericEnv } from '../env/numeric.js';

export interface PricingRateCard {
  baseFare: number;
  perKm: number;
  perMinute: number;
  /// Minutes of waiting absorbed before `perWaitingMinute` starts billing.
  freeWaitingMinutes: number;
  perWaitingMinute: number;
  platformFee: number;
  commissionRate: number;
  taxRate: number;
  minimumFare: number;
}

export interface PricingConfig {
  defaultRateCard: PricingRateCard;
}

const defaultRateCard: PricingRateCard = Object.freeze({
  baseFare: numericEnv('RIDE_BASE_FARE', 50, { min: 0 }),
  perKm: numericEnv('RIDE_RATE_PER_KM', 12, { min: 0 }),
  perMinute: numericEnv('RIDE_RATE_PER_MIN', 2, { min: 0 }),
  // Mirrors `PricingRule.freeWaitingMin`, whose column default is also 3.
  freeWaitingMinutes: numericEnv('RIDE_FREE_WAIT_MIN', 3, { min: 0 }),
  perWaitingMinute: numericEnv('RIDE_RATE_PER_WAIT_MIN', 3, { min: 0 }),
  platformFee: numericEnv('RIDE_PLATFORM_FEE', 15, { min: 0 }),
  commissionRate: numericEnv('RIDE_COMMISSION_RATE', 0.2, { min: 0, max: 1 }),
  taxRate: numericEnv('RIDE_TAX_RATE', 0.05, { min: 0, max: 1 }),
  minimumFare: numericEnv('RIDE_MINIMUM_FARE', 50, { min: 0 }),
});

export const pricingConfig: PricingConfig = Object.freeze({
  defaultRateCard,
});
