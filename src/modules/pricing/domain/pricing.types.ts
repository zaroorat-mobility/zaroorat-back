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
  isNightTrip?: boolean;
  rateCard?: PricingRateCard;
}

export interface FinalFareParams {
  actualDistanceKm: number;
  actualDurationMin: number;
  vehicleTypeId: string;
  cityCode?: string;
  serviceType?: RideServiceType;
  pickupLat?: number;
  pickupLng?: number;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
  isNightTrip?: boolean;
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
  nightAdjustment: number;
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
