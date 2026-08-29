import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager.js';
import { Prisma } from '../../generated/prisma/index.js';
import {
  PromoCodeInvalidError,
  PromoCodeNotFoundError,
  PromoLimitReachedError,
  PromoNotEligibleError,
} from './errors.js';
import type {
  DiscountType,
  PromoEligibilityContext,
  PromoQuoteResult,
  ResolvedPromo,
  SegmentRules,
} from './types.js';

const Decimal = Prisma.Decimal;

function toNum(value: { toString(): string } | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

function normalizeDiscountType(raw: string): DiscountType {
  const upper = raw.trim().toUpperCase();
  if (upper === 'PERCENT' || upper === 'PERCENTAGE' || upper === '%') return 'PERCENT';
  return 'FIXED';
}

function computeDiscountAmount(
  discountType: DiscountType,
  discountValue: number,
  maxDiscount: number | null,
  subtotal: number,
): number {
  let amount =
    discountType === 'PERCENT'
      ? (subtotal * discountValue) / 100
      : Math.min(discountValue, subtotal);
  if (maxDiscount != null && maxDiscount >= 0) {
    amount = Math.min(amount, maxDiscount);
  }
  amount = Math.min(amount, Math.max(0, subtotal));
  return Math.round(amount * 100) / 100;
}

/// FR-021. `firstRideOnly` is accepted by `createSegmentBodySchema` and was
/// evaluated by nothing, so a segment defined as "first-ride riders in
/// Bengaluru" matched every Bengaluru rider. It needs the ride count, which the
/// caller supplies rather than this function querying — `assertPromotionEligible`
/// already has it for the promotion-level `firstRideOnly` check a few lines up,
/// and running the same count twice per eligibility test would be wasteful.
function matchesSegmentRules(
  rules: SegmentRules | null | undefined,
  ctx: PromoEligibilityContext,
  completedRides: number | null,
): boolean {
  if (!rules || typeof rules !== 'object') return true;
  if (rules.firstRideOnly) {
    // Unknown ride count means the restriction cannot be evaluated, and an
    // unevaluable restriction denies (the FR-018 rule, applied here too).
    if (completedRides === null || completedRides > 0) return false;
  }
  if (rules.userIds?.length) {
    if (!ctx.userId || !rules.userIds.includes(ctx.userId)) return false;
  }
  if (rules.cityCodes?.length) {
    if (!ctx.cityCode || !rules.cityCodes.includes(ctx.cityCode)) return false;
  }
  if (rules.vehicleTypeIds?.length) {
    if (!ctx.vehicleTypeId || !rules.vehicleTypeIds.includes(ctx.vehicleTypeId)) return false;
  }
  return true;
}

type DbClient = DatabaseService['client'] | TransactionClient;

/// Prisma reports a unique violation as P2002 from the query engine, and as
/// P2010 with a driver-adapter cause when it comes from a raw statement. Both
/// shapes reach this module, so both are recognised.
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2002') return true;
  if (err.code !== 'P2010') return false;
  const meta = err.meta as { driverAdapterError?: { cause?: { kind?: string } } } | undefined;
  return meta?.driverAdapterError?.cause?.kind === 'UniqueConstraintViolation';
}

type PromotionRow = {
  id: string;
  code: string;
  title: string | null;
  discountType: string;
  discountValue: { toString(): string };
  maxDiscount: { toString(): string } | null;
  minFare: { toString(): string };
  applicableCity: string | null;
  applicableVehicleType: string | null;
  firstRideOnly: boolean;
  usageLimitTotal: number | null;
  usageLimitPerUser: number | null;
  usedCount: number;
  validFrom: Date;
  validTo: Date;
  isActive: boolean;
};

export class PromotionService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get db(): DatabaseService['client'] {
    return this.databaseService.client;
  }

  computeDiscount(
    discountType: string,
    discountValue: number,
    maxDiscount: number | null,
    subtotal: number,
  ): number {
    return computeDiscountAmount(
      normalizeDiscountType(discountType),
      discountValue,
      maxDiscount,
      subtotal,
    );
  }

  /**
   * Soft validation for fare quotes: invalid codes yield applied=false instead of throwing.
   */
  async quotePromo(
    code: string | undefined | null,
    ctx: PromoEligibilityContext,
  ): Promise<PromoQuoteResult> {
    if (!code?.trim()) {
      return { applied: false, discountAmount: 0, promo: null };
    }
    try {
      const promo = await this.validateAndResolve(code.trim(), {
        ...ctx,
        softUserChecks: ctx.userId == null,
      });
      return { applied: true, discountAmount: promo.discountAmount, promo };
    } catch (err) {
      if (
        err instanceof PromoCodeNotFoundError ||
        err instanceof PromoCodeInvalidError ||
        err instanceof PromoNotEligibleError
      ) {
        return {
          applied: false,
          discountAmount: 0,
          promo: null,
          errorCode: err.code,
          errorMessage: err.message,
        };
      }
      throw err;
    }
  }

  async validateAndResolve(
    code: string,
    ctx: PromoEligibilityContext,
    client: DbClient = this.db,
  ): Promise<ResolvedPromo> {
    const normalized = code.trim().toUpperCase();
    // FR-044. Exact match on the already-normalised value, so the unique index
    // on upper(code) answers this. `mode: 'insensitive'` compiled to ILIKE and
    // sequentially scanned a table coupon generation is built to grow large.
    const coupon = await client.coupon.findFirst({
      where: { code: normalized },
      include: {
        batch: {
          include: {
            promotion: true,
          },
        },
      },
    });

    let promotion: PromotionRow;
    let couponId: string | null = null;
    let resolvedCode: string;

    if (coupon) {
      if (!coupon.batch.isActive) {
        throw new PromoCodeInvalidError('Coupon batch is inactive');
      }
      if (coupon.status !== 'ACTIVE' && coupon.status !== 'ASSIGNED') {
        throw new PromoCodeInvalidError(`Coupon is ${coupon.status.toLowerCase()}`);
      }
      if (coupon.expiresAt && coupon.expiresAt < new Date()) {
        throw new PromoCodeInvalidError('Coupon has expired');
      }
      if (coupon.batch.expiresAt && coupon.batch.expiresAt < new Date()) {
        throw new PromoCodeInvalidError('Coupon batch has expired');
      }
      if (coupon.userId && ctx.userId && coupon.userId !== ctx.userId) {
        throw new PromoNotEligibleError('Coupon is assigned to another user');
      }
      promotion = coupon.batch.promotion;
      couponId = coupon.id;
      resolvedCode = coupon.code;
    } else {
      const promo = await client.promotion.findFirst({
        where: { code: normalized },
      });
      if (!promo) {
        throw new PromoCodeNotFoundError(`Promo code "${code}" was not found`);
      }
      promotion = promo;
      resolvedCode = promo.code;
    }

    await this.assertPromotionEligible(promotion, ctx, client);

    const discountType = normalizeDiscountType(promotion.discountType);
    const discountValue = toNum(promotion.discountValue);
    const maxDiscount = promotion.maxDiscount == null ? null : toNum(promotion.maxDiscount);
    const discountAmount = computeDiscountAmount(
      discountType,
      discountValue,
      maxDiscount,
      ctx.subtotal,
    );

    return {
      promotionId: promotion.id,
      code: resolvedCode,
      title: promotion.title,
      discountType,
      discountValue,
      maxDiscount,
      minFare: toNum(promotion.minFare),
      couponId,
      discountAmount,
    };
  }

  /// The next free ordinal for this (promotion, user) pair. Racy on its own —
  /// two callers can read the same count — which is exactly why the unique index
  /// over the triple is the thing that decides, and this is only the value that
  /// lets the winner insert without a retry loop.
  private async nextUserUseIndex(
    client: DbClient,
    promotionId: string,
    userId: string,
  ): Promise<number> {
    const used = await client.promotionRedemption.count({ where: { promotionId, userId } });
    return used + 1;
  }

  private async assertPromotionEligible(
    promotion: PromotionRow,
    ctx: PromoEligibilityContext,
    client: DbClient,
  ): Promise<void> {
    const now = new Date();
    if (!promotion.isActive) {
      throw new PromoCodeInvalidError('Promotion is inactive');
    }
    if (promotion.validFrom > now) {
      throw new PromoCodeInvalidError('Promotion is not yet valid');
    }
    if (promotion.validTo < now) {
      throw new PromoCodeInvalidError('Promotion has expired');
    }
    if (ctx.subtotal < toNum(promotion.minFare)) {
      throw new PromoNotEligibleError(
        `Minimum ride amount of ${toNum(promotion.minFare)} required`,
      );
    }
    if (promotion.applicableCity) {
      if (!ctx.cityCode || promotion.applicableCity !== ctx.cityCode) {
        throw new PromoNotEligibleError('Promotion is not valid in this city');
      }
    }
    // FR-018. The city branch above treats a missing context value as a refusal;
    // this one used to treat it as a pass, so a bike-only promotion applied to a
    // premium cab whenever the caller happened not to supply a vehicle type. A
    // restriction that cannot be evaluated must deny, not admit.
    if (promotion.applicableVehicleType) {
      if (!ctx.vehicleTypeId || promotion.applicableVehicleType !== ctx.vehicleTypeId) {
        throw new PromoNotEligibleError('Promotion is not valid for this vehicle type');
      }
    }
    if (promotion.usageLimitTotal != null && promotion.usedCount >= promotion.usageLimitTotal) {
      throw new PromoCodeInvalidError('Promotion usage limit reached');
    }

    // FR-043. Null is unlimited, matching `usageLimitTotal`. The column used to be
    // a non-null Int where 0 meant "nobody may ever use this" — `userUses >= 0`
    // is true for a user who has never redeemed — which is the opposite of how
    // anyone reads a 0 limit.
    const perUserLimit = promotion.usageLimitPerUser;
    const needsUser = promotion.firstRideOnly || perUserLimit !== null;
    if (needsUser && !ctx.userId && !ctx.softUserChecks) {
      throw new PromoNotEligibleError('User is required to apply this promotion');
    }

    // Counted at most once per eligibility check, and only if something actually
    // asks: the promotion's own `firstRideOnly`, or a campaign segment carrying
    // the same rule. Running it unconditionally would add a `rides` count to
    // every quote for every vehicle category.
    let completedRidesCache: number | null = null;
    const completedRides = async (): Promise<number | null> => {
      if (!ctx.userId) return null;
      completedRidesCache ??= await client.ride.count({
        where: { customerId: ctx.userId, status: 'COMPLETED' },
      });
      return completedRidesCache;
    };

    if (ctx.userId) {
      if (promotion.firstRideOnly && (await completedRides())! > 0) {
        throw new PromoNotEligibleError('Promotion is for first ride only');
      }
      if (perUserLimit !== null) {
        const userUses = await client.promotionRedemption.count({
          where: { promotionId: promotion.id, userId: ctx.userId },
        });
        if (userUses >= perUserLimit) {
          throw new PromoNotEligibleError('Per-user usage limit reached');
        }
      }
    }

    const targets = await client.campaignTarget.findMany({
      where: { promotionId: promotion.id },
      include: { segment: true },
    });
    if (targets.length > 0) {
      const rulesets = targets.map((t) => t.segment.rules as SegmentRules | null);
      const needsRideCount = rulesets.some((r) => r?.firstRideOnly);
      const rides = needsRideCount ? await completedRides() : null;
      const matched = rulesets.some((rules) => matchesSegmentRules(rules, ctx, rides));
      if (!matched) {
        throw new PromoNotEligibleError('User does not match campaign audience');
      }
    }
  }

  /// FR-017. The moment the caps are actually enforced.
  ///
  /// Eligibility was checked at booking; this runs inside the completion
  /// transaction minutes later, and between the two the promotion may have been
  /// exhausted by someone else. Re-reading the counts here would only narrow the
  /// window, not close it, so neither cap is decided by a read:
  ///
  ///   * the total is a conditional UPDATE whose affected-row count decides the
  ///     outcome — the `updateStatusIf` / `respondIfPending` shape this codebase
  ///     already uses for single-winner transitions (constitution 5.2);
  ///   * the per-user cap is the unique index on
  ///     (promotion_id, user_id, user_use_index). Two concurrent completions for
  ///     one rider compute the same next slot and one of them loses the insert
  ///     (constitution 5.4).
  ///
  /// Both raise `PromoLimitReachedError`, which aborts the completion
  /// transaction. That is deliberate: a ride must not complete recording a
  /// discount the platform then refuses to honour.
  async redeem(params: {
    promo: ResolvedPromo;
    userId: string;
    rideId: string;
    client: TransactionClient;
  }): Promise<void> {
    const { promo, userId, rideId, client } = params;

    const promotion = await client.promotion.findUnique({
      where: { id: promo.promotionId },
      select: { usageLimitTotal: true, usageLimitPerUser: true },
    });
    if (!promotion) throw new PromoCodeNotFoundError('Promotion no longer exists');

    // Conditional claim on the total. `updateMany` rather than `update` because
    // the guard belongs in the WHERE clause: with `usage_limit_total` null the
    // promotion is unlimited and the row always matches.
    const claimed = await client.promotion.updateMany({
      where: {
        id: promo.promotionId,
        ...(promotion.usageLimitTotal !== null
          ? { usedCount: { lt: promotion.usageLimitTotal } }
          : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new PromoLimitReachedError('Promotion usage limit reached');
    }

    const userUseIndex = await this.nextUserUseIndex(client, promo.promotionId, userId);
    if (promotion.usageLimitPerUser !== null && userUseIndex > promotion.usageLimitPerUser) {
      throw new PromoLimitReachedError('Per-user usage limit reached');
    }

    try {
      await client.promotionRedemption.create({
        data: {
          promotionId: promo.promotionId,
          userId,
          rideId,
          userUseIndex,
          discountAmount: new Decimal(promo.discountAmount),
        },
      });
    } catch (err) {
      // The unique index did its job: a concurrent completion for this rider took
      // the same slot. Reported as the limit it enforces, not as a raw conflict.
      if (isUniqueViolation(err)) {
        throw new PromoLimitReachedError('Per-user usage limit reached');
      }
      throw err;
    }

    await client.ridePromoApplied.create({
      data: {
        rideId,
        promoCode: promo.code,
        promoId: promo.promotionId,
        discountAmount: new Decimal(promo.discountAmount),
      },
    });

    if (promo.couponId) {
      await client.coupon.update({
        where: { id: promo.couponId },
        data: {
          status: 'REDEEMED',
          redeemedRideId: rideId,
          redeemedAt: new Date(),
          userId,
        },
      });
    }
  }
}
