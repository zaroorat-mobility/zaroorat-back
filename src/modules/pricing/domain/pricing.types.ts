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
