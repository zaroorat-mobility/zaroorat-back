import { pricingConfig, type PricingRateCard } from '@config';
import { GLOBAL_PRICING_CITY_CODE } from '../constants.js';
import { Prisma } from '../../../generated/prisma/index.js';
import type { PricingRule, RideServiceType } from '../../../generated/prisma/index.js';
import { PricingRuleRepository } from '../repositories/pricing-rule.repository.js';
import { calculateHaversineDistanceKm } from '../utils/distance.util.js';
import { MAX_SURGE_MULTIPLIER, MIN_SURGE_MULTIPLIER } from './surge.service.js';
import { PricingMetrics } from '../metrics/pricing.metrics.js';
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

/// FR-010. Money is computed in `Prisma.Decimal` and only becomes a `number` at
/// the boundary, where `ItemizedFareResult` and the API contract require one.
///
/// The arithmetic used to run in binary floating point with a
/// `Math.round(v * 100) / 100` after each step. Two costs, both real: 0.1 + 0.2
/// is not 0.3 in binary, and rounding at every intermediate step means the
/// rounding errors compound down a chain of eight operations rather than being
/// taken once at the end. The values are written to `ride_fares` as
/// `Decimal(10,2)` and drive the settlement ledger, so a rounding difference is
/// a real paise that has to come from somewhere.
const D = (value: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(value);
const ZERO = D(0);

/// Round to paise, half away from zero — the rule an invoice is read with.
function toPaise(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
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
  constructor(
    private readonly pricingRuleRepository: PricingRuleRepository,
    private readonly pricingMetrics: PricingMetrics,
  ) {}

  rateCardFor(rule: PricingRule | null): PricingRateCard {
    const fallback = pricingConfig.defaultRateCard;
    if (!rule) return fallback;
    return Object.freeze({
      baseFare: decimal(rule.baseFare) ?? fallback.baseFare,
      perKm: decimal(rule.perKmRate) ?? fallback.perKm,
      perMinute: decimal(rule.perMinuteRate) ?? fallback.perMinute,
      perWaitingMinute: decimal(rule.waitingPerMin) ?? fallback.perWaitingMinute,
      // `freeWaitingMin` is on every rule and was read by nothing: the rate card
      // it maps into had no field for it, so the grace period an operator set was
      // dropped between the rule and the price.
      freeWaitingMin: rule.freeWaitingMin ?? fallback.freeWaitingMin,
      bookingFee: decimal(rule.bookingFee) ?? fallback.bookingFee,
      platformFeePct: decimal(rule.platformFeePct) ?? fallback.platformFeePct,
      /// FR-009. The environment default applies only where the rule is silent.
      /// This used to read `fallback.platformFeeFlat` unconditionally, so a rule
      /// that set `platformFeePct = 0` — the only way to say "no platform fee in
      /// this city" — still charged the env's flat fee on every ride.
      platformFeeFlat: decimal(rule.platformFeeFlat) ?? fallback.platformFeeFlat,
      taxRatePct: decimal(rule.taxRatePct) ?? fallback.taxRatePct,
      commissionRatePct: decimal(rule.commissionRatePct) ?? fallback.commissionRatePct,
      minimumFare: decimal(rule.minimumFare) ?? fallback.minimumFare,
    });
  }

  async rateCardForTypeId(
    vehicleTypeId: string,
    cityCode?: string,
    options?: RateCardLookupOptions,
  ): Promise<PricingRateCard> {
    return (await this.resolveRateCard(vehicleTypeId, cityCode, options)).card;
  }

  /// FR-002. The same resolution as `rateCardForTypeId`, and the identity of the
  /// rule it landed on.
  ///
  /// Booking records that id so completion can price the ride on the rule the
  /// customer was quoted against, instead of re-resolving one from a context the
  /// completion path does not have. `ruleId` is null when no rule matched at all
  /// — the card is then the configured default, which has no row to point at.
  async resolveRateCard(
    vehicleTypeId: string,
    cityCode?: string,
    options?: RateCardLookupOptions,
  ): Promise<{ card: PricingRateCard; ruleId: string | null }> {
    const rule = await this.pricingRuleRepository.findBestActiveRule({
      vehicleTypeId,
      ...(cityCode !== undefined ? { cityCode } : {}),
      ...(options?.serviceType !== undefined ? { serviceType: options.serviceType } : {}),
      ...(options?.pickupLat !== undefined ? { pickupLat: options.pickupLat } : {}),
      ...(options?.pickupLng !== undefined ? { pickupLng: options.pickupLng } : {}),
    });
    return { card: this.rateCardFor(rule), ruleId: rule?.id ?? null };
  }

  /// FR-001. The card a booked ride must be billed on.
  ///
  /// Falls back to live resolution when the request carries no rule id: rows
  /// written by the previous application version have none, and migrate-then-
  /// deploy guarantees such rows exist during a rollout.
  async rateCardForRuleId(
    pricingRuleId: string | null | undefined,
    fallback: { vehicleTypeId: string; cityCode?: string; options?: RateCardLookupOptions },
  ): Promise<PricingRateCard> {
    if (pricingRuleId) {
      const rule = await this.pricingRuleRepository.findById(pricingRuleId);
      if (rule) return this.rateCardFor(rule);
    } else {
      // Expected only while requests written by the previous application version
      // are still completing. A counter that does not decay to zero means the
      // booking path stopped recording the rule.
      this.pricingMetrics.finalFareRuleMissing();
    }
    return this.rateCardForTypeId(fallback.vehicleTypeId, fallback.cityCode, fallback.options);
  }

  /// FR-041. Rate cards for a whole catalog at one pickup point, resolved on the
  /// same basis the quote will use for that point. A type with no rule of its own
  /// gets the default card — exactly what the quote would price it at.
  async rateCardsForPoint(params: {
    vehicleTypeIds: readonly string[];
    cityCode?: string | undefined;
    serviceType?: RideServiceType | undefined;
    pickupLat: number;
    pickupLng: number;
  }): Promise<Map<string, PricingRateCard>> {
    const rules = await this.pricingRuleRepository.findBestActiveRulesForPoint(params);
    return new Map(
      params.vehicleTypeIds.map((id) => [id, this.rateCardFor(rules.get(id) ?? null)] as const),
    );
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

  /// FR-006 through FR-011. The whole fare, in one place, in `Decimal`.
  ///
  /// The order of operations here is the substance of BD-1 and BD-2, so it is
  /// spelled out rather than left to be reconstructed from the code:
  ///
  ///   1. The ride fare is built up and surge applied.
  ///   2. **The minimum-fare floor binds on the fare, before any discount.**
  ///   3. The discount then reduces what the customer actually pays.
  ///   4. Tax and the platform fee are computed on that reduced amount.
  ///   5. The driver is paid out of the *pre-discount* ride revenue (BD-2 A).
  ///   6. The platform takes what is left (FR-006).
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

    const distanceFare = toPaise(D(billableDistanceKm).times(card.perKm));
    const timeFare = toPaise(D(billableDurationMin).times(card.perMinute));
    const billableWaitingMin = Math.max(0, (params.waitingMinutes ?? 0) - card.freeWaitingMin);
    const waitingCharge = toPaise(D(billableWaitingMin).times(card.perWaitingMinute));
    const bookingFee = toPaise(D(card.bookingFee));

    /// FR-047. A night multiplier used to be applied here, gated on an
    /// `isNightTrip` flag that no caller in the codebase ever set. The admin form
    /// collected a night percentage, the service converted it to a multiplier,
    /// the column stored it, the rate card carried it — and the branch that would
    /// have charged it was unreachable. Every part of that chain is removed
    /// rather than left in place looking configured; the column itself goes in
    /// the deferred drop, one release after this one.
    const subtotalBeforeSurge = toPaise(
      D(card.baseFare).plus(distanceFare).plus(timeFare).plus(waitingCharge).plus(bookingFee),
    );

    // FR-011. `SurgeService` already clamps, so today every caller arrives inside
    // the band. The bound belongs here too: this is a public method taking a
    // plain number, and the completion path reads its multiplier back out of a
    // persisted row rather than from the service that bounded it.
    const surgeMultiplier = Math.min(
      MAX_SURGE_MULTIPLIER,
      Math.max(MIN_SURGE_MULTIPLIER, params.surgeMultiplier ?? 1),
    );
    const surgeAmount = toPaise(subtotalBeforeSurge.times(D(surgeMultiplier).minus(1)));
    const subtotal = toPaise(subtotalBeforeSurge.plus(surgeAmount));

    /// FR-008. The floor binds here, on the fare, **before** the discount.
    ///
    /// It used to bind on the post-discount total: `max(minimumFare, taxable +
    /// tax + fee)`. On a short trip the floor then won outright, the customer
    /// paid the full minimum, and the promotion reduced the bill by nothing — yet
    /// `promotionRedemption` was still written, `usedCount` still incremented and
    /// the coupon still burned. The customer spent a single-use promotion and
    /// received no discount for it.
    const flooredFare = Prisma.Decimal.max(D(card.minimumFare), subtotal);

    /// A discount can take the payable amount to zero but not below it, and the
    /// second half of FR-008 is that what we record is what we actually granted —
    /// not what was asked for.
    const requestedDiscount = Prisma.Decimal.max(ZERO, D(params.discountAmount ?? 0));
    const discount = toPaise(Prisma.Decimal.min(requestedDiscount, flooredFare));
    const netFare = toPaise(flooredFare.minus(discount));

    const taxAmount = toPaise(netFare.times(D(card.taxRatePct)).dividedBy(100));
    /// FR-009. A percentage takes precedence; the flat fee is the fallback, and
    /// it now comes from the rule when the rule sets one. A rule that wants no
    /// platform fee sets both to zero — previously impossible, because a zero
    /// percentage fell through to the environment's flat fee.
    const platformFee =
      card.platformFeePct > 0
        ? toPaise(netFare.times(D(card.platformFeePct)).dividedBy(100))
        : toPaise(D(card.platformFeeFlat));

    const totalFare = toPaise(netFare.plus(taxAmount).plus(platformFee));

    /// BD-1 option A. Commission is levied on ride revenue only — what the
    /// journey itself earned. Tax is remitted to the state and the platform fee
    /// is already the platform's, so neither is the driver's to be charged
    /// against; the booking fee is a platform charge rather than fare for the
    /// ride. Previously the base was `totalFare`, which contained all three, so
    /// at the default card a 300 subtotal settled as 66.00 commission / 264.00
    /// driver where the intended split is 60.00 / 240.00.
    const rideRevenue = Prisma.Decimal.max(ZERO, flooredFare.minus(bookingFee));

    /// BD-2 option A. The driver earns on the **pre-discount** revenue: a
    /// promotion is the platform's marketing decision and a driver has no say in
    /// it. Previously the discount came off before the driver's share was
    /// computed, so the driver silently funded roughly 80% of every campaign.
    const driverEarning = toPaise(
      rideRevenue.times(D(100).minus(D(card.commissionRatePct))).dividedBy(100),
    );

    /// FR-006. The platform takes the residual, which makes
    /// `driverEarning + platformCommission + platformFee + taxAmount ===
    /// totalFare` true by construction rather than approximately true.
    ///
    /// It goes **negative** when a discount exceeds the platform's gross margin,
    /// and that is the honest number: under BD-2 the platform funds the campaign,
    /// so on a heavily discounted ride it really does pay out more than it
    /// collected. `LedgerService` posts no commission entries when this is not
    /// positive, so a negative residual is currently absent from the books rather
    /// than recorded as a platform cost — see the Phase 2 notes.
    const platformCommission = toPaise(
      totalFare.minus(taxAmount).minus(platformFee).minus(driverEarning),
    );

    return {
      estimatedDistanceKm: billableDistanceKm,
      estimatedDurationMin: billableDurationMin,
      baseFare: card.baseFare,
      distanceFare: distanceFare.toNumber(),
      timeFare: timeFare.toNumber(),
      waitingCharge: waitingCharge.toNumber(),
      bookingFee: bookingFee.toNumber(),
      surgeMultiplier,
      surgeAmount: surgeAmount.toNumber(),
      subtotal: subtotal.toNumber(),
      discountAmount: discount.toNumber(),
      taxAmount: taxAmount.toNumber(),
      platformFee: platformFee.toNumber(),
      totalFare: totalFare.toNumber(),
      driverEarning: driverEarning.toNumber(),
      platformCommission: platformCommission.toNumber(),
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
      (await this.rateCardForRuleId(params.pricingRuleId, {
        vehicleTypeId: params.vehicleTypeId,
        ...(params.cityCode !== undefined ? { cityCode: params.cityCode } : {}),
        options: {
          ...(params.serviceType !== undefined ? { serviceType: params.serviceType } : {}),
          ...(params.pickupLat !== undefined ? { pickupLat: params.pickupLat } : {}),
          ...(params.pickupLng !== undefined ? { pickupLng: params.pickupLng } : {}),
        },
      }));
    return this.price(params.actualDistanceKm, params.actualDurationMin, card, params);
  }
}
