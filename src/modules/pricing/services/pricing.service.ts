import { pricingConfig, type PricingRateCard } from '@config';
import type { PricingRule } from '../../../generated/prisma/index.js';
import { PricingRuleRepository } from '../repositories/pricing-rule.repository.js';
import { calculateHaversineDistanceKm } from '../utils/distance.util.js';
import type {
  FareCalculationParams,
  FinalFareParams,
  ItemizedFareResult,
  RateCardLookupOptions,
} from '../domain/pricing.types.js';

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function decimal(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PricingService {
  constructor(private readonly pricingRuleRepository: PricingRuleRepository) {}

  rateCardFor(rule: PricingRule | null): PricingRateCard {
    const fallback = pricingConfig.defaultRateCard;
    if (!rule) return fallback;
    return Object.freeze({
      baseFare: decimal(rule.baseFare) ?? fallback.baseFare,
      perKm: decimal(rule.perKmRate) ?? fallback.perKm,
      perMinute: decimal(rule.perMinuteRate) ?? fallback.perMinute,
      perWaitingMinute: decimal(rule.waitingPerMin) ?? fallback.perWaitingMinute,
      freeWaitingMin: rule.freeWaitingMin ?? fallback.freeWaitingMin,
      bookingFee: decimal(rule.bookingFee) ?? fallback.bookingFee,
      platformFeePct: decimal(rule.platformFeePct) ?? fallback.platformFeePct,
      platformFeeFlat: fallback.platformFeeFlat,
      taxRatePct: decimal(rule.taxRatePct) ?? fallback.taxRatePct,
      commissionRatePct: decimal(rule.commissionRatePct) ?? fallback.commissionRatePct,
      minimumFare: decimal(rule.minimumFare) ?? fallback.minimumFare,
      nightMultiplier: decimal(rule.nightMultiplier) ?? fallback.nightMultiplier,
    });
  }

  async rateCardForTypeId(
    vehicleTypeId: string,
    cityCode?: string,
    options?: RateCardLookupOptions,
  ): Promise<PricingRateCard> {
    const rule = await this.pricingRuleRepository.findBestActiveRule({
      vehicleTypeId,
      ...(cityCode !== undefined ? { cityCode } : {}),
      ...(options?.serviceType !== undefined ? { serviceType: options.serviceType } : {}),
      ...(options?.pickupLat !== undefined ? { pickupLat: options.pickupLat } : {}),
      ...(options?.pickupLng !== undefined ? { pickupLng: options.pickupLng } : {}),
    });
    return this.rateCardFor(rule);
  }

  private price(
    distanceKm: number,
    durationMin: number,
    card: PricingRateCard,
    params: {
      surgeMultiplier?: number;
      waitingMinutes?: number;
      discountAmount?: number;
      isNightTrip?: boolean;
    },
  ): ItemizedFareResult {
    const billableDistanceKm = Math.max(0, distanceKm);
    const billableDurationMin = Math.max(0, durationMin);
    const distanceFare = money(billableDistanceKm * card.perKm);
    const timeFare = money(billableDurationMin * card.perMinute);
    const billableWaitingMin = Math.max(0, (params.waitingMinutes ?? 0) - card.freeWaitingMin);
    const waitingCharge = money(billableWaitingMin * card.perWaitingMinute);
    const bookingFee = money(card.bookingFee);
    const rawSubtotal = card.baseFare + distanceFare + timeFare + waitingCharge + bookingFee;

    const nightMultiplier =
      params.isNightTrip && card.nightMultiplier > 1 ? card.nightMultiplier : 1;
    const nightAdjustment = money(rawSubtotal * (nightMultiplier - 1));
    const subtotalBeforeSurge = money(rawSubtotal + nightAdjustment);

    const surgeMultiplier = params.surgeMultiplier ?? 1;
    const surgeAmount = money(subtotalBeforeSurge * (surgeMultiplier - 1));
    const subtotal = money(subtotalBeforeSurge + surgeAmount);
    const discountAmount = Math.max(0, params.discountAmount ?? 0);
    const taxable = Math.max(0, subtotal - discountAmount);
    const taxAmount = money(taxable * (card.taxRatePct / 100));
    const platformFee =
      card.platformFeePct > 0
        ? money(taxable * (card.platformFeePct / 100))
        : money(card.platformFeeFlat);
    const totalFare = money(Math.max(card.minimumFare, taxable + taxAmount + platformFee));
    const platformCommission = money(totalFare * (card.commissionRatePct / 100));
    const driverEarning = money(totalFare - platformCommission);

    return {
      estimatedDistanceKm: billableDistanceKm,
      estimatedDurationMin: billableDurationMin,
      baseFare: card.baseFare,
      distanceFare,
      timeFare,
      waitingCharge,
      bookingFee,
      nightAdjustment,
      surgeMultiplier,
      surgeAmount,
      subtotal,
      discountAmount,
      taxAmount,
      platformFee,
      totalFare,
      driverEarning,
      platformCommission,
    };
  }

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
    const card =
      params.rateCard ??
      (await this.rateCardForTypeId(params.vehicleTypeId, params.cityCode, {
        ...(params.serviceType !== undefined ? { serviceType: params.serviceType } : {}),
        pickupLat: params.pickupLat,
        pickupLng: params.pickupLng,
      }));
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
    const card =
      params.rateCard ??
      (await this.rateCardForTypeId(params.vehicleTypeId, params.cityCode, {
        ...(params.serviceType !== undefined ? { serviceType: params.serviceType } : {}),
        ...(params.pickupLat !== undefined ? { pickupLat: params.pickupLat } : {}),
        ...(params.pickupLng !== undefined ? { pickupLng: params.pickupLng } : {}),
      }));
    return this.price(params.actualDistanceKm, params.actualDurationMin, card, params);
  }
}
