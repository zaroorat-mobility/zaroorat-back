import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager.js';
import { Prisma } from '../../generated/prisma/index.js';
import { PromoCodeInvalidError, PromoCodeNotFoundError, PromoNotEligibleError } from './errors.js';
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

function matchesSegmentRules(
  rules: SegmentRules | null | undefined,
  ctx: PromoEligibilityContext,
): boolean {
  if (!rules || typeof rules !== 'object') return true;
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
  usageLimitPerUser: number;
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
    const coupon = await client.coupon.findFirst({
      where: { code: { equals: normalized, mode: 'insensitive' } },
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
        where: { code: { equals: normalized, mode: 'insensitive' } },
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
    if (
      promotion.applicableVehicleType &&
      ctx.vehicleTypeId &&
      promotion.applicableVehicleType !== ctx.vehicleTypeId
    ) {
      throw new PromoNotEligibleError('Promotion is not valid for this vehicle type');
    }
    if (promotion.usageLimitTotal != null && promotion.usedCount >= promotion.usageLimitTotal) {
      throw new PromoCodeInvalidError('Promotion usage limit reached');
    }

    const needsUser = promotion.firstRideOnly || promotion.usageLimitPerUser > 0;
    if (needsUser && !ctx.userId && !ctx.softUserChecks) {
      throw new PromoNotEligibleError('User is required to apply this promotion');
    }

    if (ctx.userId) {
      if (promotion.firstRideOnly) {
        const completed = await client.ride.count({
          where: { customerId: ctx.userId, status: 'COMPLETED' },
        });
        if (completed > 0) {
          throw new PromoNotEligibleError('Promotion is for first ride only');
        }
      }
      const userUses = await client.promotionRedemption.count({
        where: { promotionId: promotion.id, userId: ctx.userId },
      });
      if (userUses >= promotion.usageLimitPerUser) {
        throw new PromoNotEligibleError('Per-user usage limit reached');
      }
    }

    const targets = await client.campaignTarget.findMany({
      where: { promotionId: promotion.id },
      include: { segment: true },
    });
    if (targets.length > 0) {
      const matched = targets.some((t) =>
        matchesSegmentRules(t.segment.rules as SegmentRules | null, ctx),
      );
      if (!matched) {
        throw new PromoNotEligibleError('User does not match campaign audience');
      }
    }
  }

  async redeem(params: {
    promo: ResolvedPromo;
    userId: string;
    rideId: string;
    client: TransactionClient;
  }): Promise<void> {
    const { promo, userId, rideId, client } = params;

    await client.promotionRedemption.create({
      data: {
        promotionId: promo.promotionId,
        userId,
        rideId,
        discountAmount: new Decimal(promo.discountAmount),
      },
    });

    await client.ridePromoApplied.create({
      data: {
        rideId,
        promoCode: promo.code,
        promoId: promo.promotionId,
        discountAmount: new Decimal(promo.discountAmount),
      },
    });

    await client.promotion.update({
      where: { id: promo.promotionId },
      data: { usedCount: { increment: 1 } },
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
