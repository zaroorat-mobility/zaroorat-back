import { pricingConfig, type PricingRateCard } from '@config';
import { GLOBAL_PRICING_CITY_CODE } from '../constants.js';
import type { PricingRule } from '../../../generated/prisma/index.js';
import { PricingRuleRepository } from '../repositories/pricing-rule.repository.js';
import { calculateHaversineDistanceKm } from '../utils/distance.util.js';
import type {
  FareCalculationParams,
  FinalFareParams,
  ItemizedFareResult,
  RateCardLookupOptions,
} from '../domain/pricing.types.js';

/// Shaped so `handleRideError` recognises it: that handler duck-types on
/// `code` + `statusCode` + `message` rather than on any base class, so pricing
/// can refuse a request without the pricing module having to depend on the ride
/// module's error hierarchy.
export class ZeroDistanceTripError extends Error {
  readonly code = 'TRIP_HAS_NO_DISTANCE';
  readonly statusCode = 400;
  constructor() {
    super('Pickup and drop are the same place — there is no journey to price');
    this.name = 'ZeroDistanceTripError';
  }
}

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
      // `freeWaitingMin` is on every rule and was read by nothing: the rate card
      // it maps into had no field for it, so the grace period an operator set was
      // dropped between the rule and the price.
      freeWaitingMinutes: decimal(rule.freeWaitingMin) ?? fallback.freeWaitingMinutes,
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
    const distanceKm = money(straightLineKm * pricingConfig.roadDistanceFactor);
    // A booking whose drop is its pickup used to price at the minimum fare and
    // go out to dispatch: a driver was sent to a customer already standing at
    // their destination, and the customer paid the floor for a journey that
    // could not happen. The realistic cause is a client that never set the drop
    // and sent the pickup twice, or a second GPS read of the same spot — so the
    // test is "zero at the precision we price in", not exact equality of the
    // coordinates.
    //
    // Guarded here rather than in the two request schemas because this is the
    // one place both quoting and booking pass through, and it is the only place
    // that knows the road factor and the rounding that decide when a distance
    // has vanished.
    //
    // Deliberately not applied to `calculateFinalFare`: a *completed* ride
    // reporting no distance is a different situation entirely, and refusing it
    // would leave a driver who has finished driving unable to close the ride.
    if (distanceKm <= 0) throw new ZeroDistanceTripError();
    return {
      distanceKm,
      durationMin: Math.max(1, Math.round(distanceKm * pricingConfig.minutesPerKm)),
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
    // The multi-category quote estimates the trip once and passes it in: the
    // journey does not change between a bike and a premium cab, and recomputing
    // it inside that loop ran the same haversine once per category.
    const trip =
      params.trip ??
      this.estimateTrip({
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
