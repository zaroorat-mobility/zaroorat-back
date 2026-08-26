import { pricingConfig, type PricingRateCard } from '@config';
import { GLOBAL_PRICING_CITY_CODE } from '../constants.js';
import type { PricingRule } from '../../../generated/prisma/index.js';
import { PricingRuleRepository } from '../repositories/pricing-rule.repository.js';
import { calculateHaversineDistanceKm } from '../utils/distance.util.js';
import type {
  FareCalculationParams,
  FinalFareParams,
  ItemizedFareResult,
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

  /// Maps a PricingRule row onto a rate card. Pure and synchronous on purpose:
  /// every field falls back to `pricingConfig.defaultRateCard` individually.
  /// `commissionRate`, `taxRate` and `platformFee` stay platform-wide config.
  rateCardFor(rule: PricingRule | null): PricingRateCard {
    const fallback = pricingConfig.defaultRateCard;
    if (!rule) return fallback;
    return Object.freeze({
      baseFare: decimal(rule.baseFare) ?? fallback.baseFare,
      perKm: decimal(rule.perKmRate) ?? fallback.perKm,
      perMinute: decimal(rule.perMinuteRate) ?? fallback.perMinute,
      // `freeWaitingMin` is on every rule and was read by nothing: the rate card
      // it maps into had no field for it, so the grace period an operator set was
      // dropped between the rule and the price.
      freeWaitingMinutes: decimal(rule.freeWaitingMin) ?? fallback.freeWaitingMinutes,
      perWaitingMinute: decimal(rule.waitingPerMin) ?? fallback.perWaitingMinute,
      minimumFare: decimal(rule.minimumFare) ?? fallback.minimumFare,
      platformFee: fallback.platformFee,
      commissionRate: fallback.commissionRate,
      taxRate: fallback.taxRate,
    });
  }

  /// The one I/O path to a rate card. It looks for a specific city's rule,
  /// falls back to 'GLOBAL', and if neither exist, returns the default config.
  async rateCardForTypeId(vehicleTypeId: string, cityCode?: string): Promise<PricingRateCard> {
    let rule = null;
    if (cityCode) {
      rule = await this.pricingRuleRepository.findActiveRule(vehicleTypeId, cityCode);
    }
    if (!rule) {
      rule = await this.pricingRuleRepository.findActiveRule(
        vehicleTypeId,
        GLOBAL_PRICING_CITY_CODE,
      );
    }
    return this.rateCardFor(rule);
  }

  /// Rate cards for many categories at once, for the catalog. A type with no
  /// rule of its own gets `rateCardFor(null)` — the default card — which is
  /// exactly what `rateCardForTypeId` would have priced its rides at, so the
  /// catalog cannot advertise one number and the quote charge another.
  async rateCardsForTypeIds(
    vehicleTypeIds: readonly string[],
    cityCode = GLOBAL_PRICING_CITY_CODE,
  ): Promise<Map<string, PricingRateCard>> {
    const rules = await this.pricingRuleRepository.findGlobalRules(vehicleTypeIds, cityCode);
    return new Map(
      vehicleTypeIds.map((id) => [id, this.rateCardFor(rules.get(id) ?? null)] as const),
    );
  }

  private price(
    distanceKm: number,
    durationMin: number,
    card: PricingRateCard,
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
    // Only the wait beyond the free grace period is billable. Without this the
    // first minute of waiting was charged at full rate, so the day anything
    // starts writing `Ride.waitTimeMin` every rider would have been overcharged
    // by `freeWaitingMinutes * perWaitingMinute` on top of the real wait.
    const billableWaitingMin = Math.max(0, (params.waitingMinutes ?? 0) - card.freeWaitingMinutes);
    const waitingCharge = money(billableWaitingMin * card.perWaitingMinute);
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
    const card =
      params.rateCard ?? (await this.rateCardForTypeId(params.vehicleTypeId, params.cityCode));
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
      params.rateCard ?? (await this.rateCardForTypeId(params.vehicleTypeId, params.cityCode));
    return this.price(params.actualDistanceKm, params.actualDurationMin, card, params);
  }
}
