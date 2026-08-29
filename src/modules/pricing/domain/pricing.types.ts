import type { PricingRateCard } from '@config';
import type { RideServiceType } from '../../../generated/prisma/index.js';

export interface RateCardLookupOptions {
  serviceType?: RideServiceType | undefined;
  pickupLat?: number | undefined;
  pickupLng?: number | undefined;
}

export interface FareCalculationParams {
  pickupLat: number;
  pickupLng: number;
  dropLat?: number;
  dropLng?: number;
  vehicleTypeId: string;
  cityCode?: string;
  serviceType?: RideServiceType;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
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
  /// FR-002. The rule the ride was quoted and booked on. When present it decides
  /// the card outright; the city/coordinate fields below are only the fallback
  /// for requests written before the column existed.
  pricingRuleId?: string | null;
  cityCode?: string;
  serviceType?: RideServiceType;
  pickupLat?: number;
  pickupLng?: number;
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
  bookingFee: number;
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
