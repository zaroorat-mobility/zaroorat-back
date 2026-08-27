import type { PricingRateCard } from '@config';

export interface FareCalculationParams {
  pickupLat: number;
  pickupLng: number;
  dropLat?: number;
  dropLng?: number;
  vehicleTypeId: string;
  cityCode?: string;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
  /// Pre-resolved rate card. The multi-category quote loads every active type
  /// in one query and passes each card in, so pricing N categories stays one
  /// round trip rather than N.
  rateCard?: PricingRateCard;
  /// Pre-estimated trip, for the same reason as `rateCard`: the multi-category
  /// quote works out the journey once and prices every category against it,
  /// rather than running the same haversine per category.
  trip?: TripEstimate;
}

export interface TripEstimate {
  distanceKm: number;
  durationMin: number;
}

export interface FinalFareParams {
  actualDistanceKm: number;
  actualDurationMin: number;
  vehicleTypeId: string;
  cityCode?: string;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
  rateCard?: PricingRateCard;
}

export interface ItemizedFareResult {
  estimatedDistanceKm: number;
  estimatedDurationMin: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  waitingCharge: number;
  surgeMultiplier: number;
  surgeAmount: number;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  platformFee: number;
  totalFare: number;
  driverEarning: number;
  platformCommission: number;
}
