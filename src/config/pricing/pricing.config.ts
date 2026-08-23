import { numericEnv } from '../env/numeric.js';

export interface PricingRateCard {
  baseFare: number;
  perKm: number;
  perMinute: number;
  perWaitingMinute: number;
  platformFee: number;
  commissionRate: number;
  taxRate: number;
  minimumFare: number;
}

export interface PricingConfig {
  /// Platform-wide fallback. Per-category pricing lives on `VehicleType`
  /// columns (base_fare, per_km_rate, per_minute_rate, minimum_fare,
  /// waiting_charge); this fills in any field a type leaves null, plus the
  /// three that have no column at all (platformFee, commissionRate, taxRate).
  defaultRateCard: PricingRateCard;
}

/// Every field here is money or a money multiplier, so each is read through
/// `numericEnv` rather than `Number(process.env.X ?? default)`. The bare form
/// yields `NaN` on a typo, and `NaN` defeats every downstream guard because
/// each comparison against it is false — a mistyped `RIDE_COMMISSION_RATE`
/// would silently make every driver earning and platform commission `NaN`
/// rather than failing at boot. Rates are bounded to 0–1 because they are
/// fractions, not percentages.
const defaultRateCard: PricingRateCard = Object.freeze({
  baseFare: numericEnv('RIDE_BASE_FARE', 50, { min: 0 }),
  perKm: numericEnv('RIDE_RATE_PER_KM', 12, { min: 0 }),
  perMinute: numericEnv('RIDE_RATE_PER_MIN', 2, { min: 0 }),
  perWaitingMinute: numericEnv('RIDE_RATE_PER_WAIT_MIN', 3, { min: 0 }),
  platformFee: numericEnv('RIDE_PLATFORM_FEE', 15, { min: 0 }),
  commissionRate: numericEnv('RIDE_COMMISSION_RATE', 0.2, { min: 0, max: 1 }),
  taxRate: numericEnv('RIDE_TAX_RATE', 0.05, { min: 0, max: 1 }),
  minimumFare: numericEnv('RIDE_MINIMUM_FARE', 50, { min: 0 }),
});

export const pricingConfig: PricingConfig = Object.freeze({
  defaultRateCard,
});
