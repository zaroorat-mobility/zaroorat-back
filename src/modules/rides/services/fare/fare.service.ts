import { rideConfig, type RideRateCard } from '@config';
import { calculateHaversineDistanceKm } from '../../utils/distance.util.js';

export interface FareCalculationParams {
  pickupLat: number;
  pickupLng: number;
  dropLat?: number;
  dropLng?: number;
  vehicleTypeId: string;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
}

export interface FinalFareParams {
  actualDistanceKm: number;
  actualDurationMin: number;
  vehicleTypeId: string;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
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

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export class FareService {
  rateCardFor(vehicleTypeId: string): RideRateCard {
    return rideConfig.rateCardsByVehicleType[vehicleTypeId] ?? rideConfig.defaultRateCard;
  }

  private price(
    distanceKm: number,
    durationMin: number,
    params: {
      vehicleTypeId: string;
      surgeMultiplier?: number;
      waitingMinutes?: number;
      discountAmount?: number;
    },
  ): ItemizedFareResult {
    const card = this.rateCardFor(params.vehicleTypeId);

    const billableDistanceKm = Math.max(0, distanceKm);
    const billableDurationMin = Math.max(0, durationMin);

    const distanceFare = money(billableDistanceKm * card.perKm);
    const timeFare = money(billableDurationMin * card.perMinute);
    const waitingCharge = money(Math.max(0, params.waitingMinutes ?? 0) * card.perWaitingMinute);

    const rawSubtotal = card.baseFare + distanceFare + timeFare + waitingCharge;
    const surgeMultiplier = params.surgeMultiplier ?? 1.0;
    const surgeAmount = money(rawSubtotal * (surgeMultiplier - 1.0));

    const subtotal = money(rawSubtotal + surgeAmount);
    const discountAmount = Math.max(0, params.discountAmount ?? 0);
    const taxable = Math.max(0, subtotal - discountAmount);
    const taxAmount = money(taxable * card.taxRate);

    const totalFare = money(Math.max(card.minimumFare, taxable + taxAmount + card.platformFee));

    const platformCommission = money(totalFare * card.commissionRate);

    const driverEarning = money(totalFare - platformCommission);

    return {
      estimatedDistanceKm: billableDistanceKm,
      estimatedDurationMin: billableDurationMin,
      baseFare: card.baseFare,
      distanceFare,
      timeFare,
      waitingCharge,
      surgeMultiplier,
      surgeAmount,
      subtotal,
      discountAmount,
      taxAmount,
      platformFee: card.platformFee,
      totalFare,
      driverEarning,
      platformCommission,
    };
  }

  async calculateFareQuote(params: FareCalculationParams): Promise<ItemizedFareResult> {
    const hasDrop = params.dropLat != null && params.dropLng != null;
    if (!hasDrop) {
      throw new Error(
        'A fare quote requires drop coordinates. Quoting an open-ended ride at a ' +
          'fixed default distance produced a price unrelated to the trip.',
      );
    }

    const straightLineKm = calculateHaversineDistanceKm(
      params.pickupLat,
      params.pickupLng,
      params.dropLat as number,
      params.dropLng as number,
    );

    const distanceKm = money(straightLineKm * 1.3);
    const durationMin = Math.max(1, Math.round(distanceKm * 3));

    return this.price(distanceKm, durationMin, params);
  }

  async calculateFinalFare(params: FinalFareParams): Promise<ItemizedFareResult> {
    if (!Number.isFinite(params.actualDistanceKm) || params.actualDistanceKm < 0) {
      throw new Error(
        `actualDistanceKm must be a non-negative number, got ${params.actualDistanceKm}`,
      );
    }
    if (!Number.isFinite(params.actualDurationMin) || params.actualDurationMin < 0) {
      throw new Error(
        `actualDurationMin must be a non-negative number, got ${params.actualDurationMin}`,
      );
    }

    return this.price(params.actualDistanceKm, params.actualDurationMin, params);
  }
}
