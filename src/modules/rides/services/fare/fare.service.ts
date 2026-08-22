import { rideConfig, type RideRateCard } from '@config';
import { VehicleTypeRepository } from '@modules/vehicles/repositories/vehicle-type.repository.js';
import type { VehicleType } from '@modules/vehicles/types/index.js';
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
  /// Pre-resolved rate card. The multi-category quote loads every active type
  /// in one query and passes each card in, so pricing N categories stays one
  /// round trip rather than N.
  rateCard?: RideRateCard;
}

export interface FinalFareParams {
  actualDistanceKm: number;
  actualDurationMin: number;
  vehicleTypeId: string;
  surgeMultiplier?: number;
  waitingMinutes?: number;
  discountAmount?: number;
  rateCard?: RideRateCard;
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

function decimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class FareService {
  constructor(private readonly vehicleTypeRepository: VehicleTypeRepository) {}

  /// Maps a VehicleType row onto a rate card. Pure and synchronous on purpose:
  /// every field falls back to `rideConfig.defaultRateCard` individually, so a
  /// type that sets only `perKmRate` still gets sane values for the rest, and a
  /// type with no pricing at all prices exactly as it did before pricing moved
  /// onto the table. `commissionRate`, `taxRate` and `platformFee` have no
  /// column on VehicleType and stay platform-wide config.
  rateCardFor(vehicleType: VehicleType | null): RideRateCard {
    const fallback = rideConfig.defaultRateCard;
    if (!vehicleType) return fallback;
    return Object.freeze({
      baseFare: decimal(vehicleType.baseFare) ?? fallback.baseFare,
      perKm: decimal(vehicleType.perKmRate) ?? fallback.perKm,
      perMinute: decimal(vehicleType.perMinuteRate) ?? fallback.perMinute,
      perWaitingMinute: decimal(vehicleType.waitingCharge) ?? fallback.perWaitingMinute,
      minimumFare: decimal(vehicleType.minimumFare) ?? fallback.minimumFare,
      platformFee: fallback.platformFee,
      commissionRate: fallback.commissionRate,
      taxRate: fallback.taxRate,
    });
  }

  /// The one I/O path to a rate card. An unknown id falls back to the platform
  /// default rather than throwing: callers that need a *validated* type call
  /// `VehicleTypeService.requireActive` first, and pricing should never be the
  /// thing that decides a type does not exist.
  async rateCardForTypeId(vehicleTypeId: string): Promise<RideRateCard> {
    return this.rateCardFor(await this.vehicleTypeRepository.findById(vehicleTypeId));
  }

  private price(
    distanceKm: number,
    durationMin: number,
    card: RideRateCard,
    params: {
      surgeMultiplier?: number;
      waitingMinutes?: number;
      discountAmount?: number;
    },
  ): ItemizedFareResult {
    const billableDistanceKm = Math.max(0, distanceKm);
    const billableDurationMin = Math.max(0, durationMin);
    const distanceFare = money(billableDistanceKm * card.perKm);
    const timeFare = money(billableDurationMin * card.perMinute);
    const waitingCharge = money(Math.max(0, params.waitingMinutes ?? 0) * card.perWaitingMinute);
    const rawSubtotal = card.baseFare + distanceFare + timeFare + waitingCharge;
    const surgeMultiplier = params.surgeMultiplier ?? 1;
    const surgeAmount = money(rawSubtotal * (surgeMultiplier - 1));
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

  /// Straight-line distance scaled by a road factor. Unchanged from before this
  /// module landed — replacing it needs a routing provider, which does not
  /// exist yet.
  estimateTrip(params: {
    pickupLat: number;
    pickupLng: number;
    dropLat: number;
    dropLng: number;
  }): { distanceKm: number; durationMin: number } {
    const straightLineKm = calculateHaversineDistanceKm(
      params.pickupLat,
      params.pickupLng,
      params.dropLat,
      params.dropLng,
    );
    const distanceKm = money(straightLineKm * 1.3);
    return { distanceKm, durationMin: Math.max(1, Math.round(distanceKm * 3)) };
  }

  async calculateFareQuote(params: FareCalculationParams): Promise<ItemizedFareResult> {
    const hasDrop = params.dropLat != null && params.dropLng != null;
    if (!hasDrop) {
      throw new Error(
        'A fare quote requires drop coordinates. Quoting an open-ended ride at a ' +
          'fixed default distance produced a price unrelated to the trip.',
      );
    }
    const trip = this.estimateTrip({
      pickupLat: params.pickupLat,
      pickupLng: params.pickupLng,
      dropLat: params.dropLat as number,
      dropLng: params.dropLng as number,
    });
    const card = params.rateCard ?? (await this.rateCardForTypeId(params.vehicleTypeId));
    return this.price(trip.distanceKm, trip.durationMin, card, params);
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
    const card = params.rateCard ?? (await this.rateCardForTypeId(params.vehicleTypeId));
    return this.price(params.actualDistanceKm, params.actualDurationMin, card, params);
  }
}
