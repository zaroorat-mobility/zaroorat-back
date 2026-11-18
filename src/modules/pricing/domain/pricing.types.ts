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
  /// Name of the provider that supplied this estimate (e.g. 'ola', 'google', 'mappls', 'haversine').
  source: string;
  /// Road-following coordinates from the directions provider, when available.
  path?: Array<{ latitude: number; longitude: number }>;
  encodedPolyline?: string;
}

export interface PricingSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  cityCode: string;
  pricingRuleId: string | null;
  ruleVersion: number | null;
  surgeMultiplier: number;
  surgeWindowId: string | null;
  promoCode: string | null;
  promoDiscountAmount: number;
  quotedFare: number;
  rateCard: PricingRateCard;
}

export interface FinalFareParams {
  actualDistanceKm: number;
  actualDurationMin: number;
  vehicleTypeId: string;
  /// FR-002. The rule the ride was quoted and booked on. When present it decides
  /// the card outright; the city/coordinate fields below are only the fallback
  /// for requests written before the column existed.
  pricingRuleId?: string | null;
  /// Phase 1 (M-02). Write-once snapshot captured at quote/booking time.
  /// When provided, `calculateFinalFare` prefers `pricingSnapshot.rateCard`
  /// so env or rule changes after booking can never alter the fare.
  pricingSnapshot?: PricingSnapshot | null;
  cityCode?: string;
  serviceType?: RideServiceType;
  pickupLat?: number;
  pickupLng?: number;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
  /// P-1. Cap on the final total, derived from the fare the customer was quoted.
  /// Omitted for a ride with no recorded quote, which then bills uncapped as before.
  fareCeiling?: number;
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
