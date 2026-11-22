import type { DiscountType, ClientPromotionView } from '../types.js';

function toNum(value: { toString(): string } | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value.toString());
}

export function normalizeDiscountType(raw: string): DiscountType {
  const upper = raw.trim().toUpperCase();
  if (upper === 'PERCENT' || upper === 'PERCENTAGE' || upper === '%') return 'PERCENT';
  return 'FIXED';
}

export function formatDiscountDisplay(
  discountType: DiscountType,
  discountValue: number,
  maxDiscount: number | null,
): string {
  if (discountType === 'PERCENT') {
    return maxDiscount != null && maxDiscount > 0
      ? `${discountValue}% OFF up to ₹${maxDiscount}`
      : `${discountValue}% OFF`;
  }
  return `Flat ₹${discountValue} OFF`;
}

export function toClientPromotionView(
  promo: {
    id: string;
    code: string;
    title: string | null;
    description?: string | null;
    discountType: string;
    discountValue: { toString(): string } | number;
    maxDiscount: { toString(): string } | number | null;
    minFare: { toString(): string } | number;
    applicableCity: string | null;
    applicableVehicleType: string | null;
    firstRideOnly: boolean;
    validFrom: Date;
    validTo: Date;
  },
  coupon?: { id: string; code: string; expiresAt: Date | null } | null,
): ClientPromotionView {
  const discountType = normalizeDiscountType(promo.discountType);
  const discountValue = toNum(promo.discountValue);
  const maxDiscount = promo.maxDiscount != null ? toNum(promo.maxDiscount) : null;
  const minFare = toNum(promo.minFare);

  return {
    id: promo.id,
    code: coupon ? coupon.code : promo.code,
    title: promo.title ?? null,
    description: promo.description ?? null,
    discountType,
    discountValue,
    maxDiscount,
    minFare,
    applicableCity: promo.applicableCity ?? null,
    applicableVehicleType: promo.applicableVehicleType ?? null,
    firstRideOnly: promo.firstRideOnly,
    validFrom: promo.validFrom.toISOString(),
    validTo: coupon?.expiresAt ? coupon.expiresAt.toISOString() : promo.validTo.toISOString(),
    isCoupon: Boolean(coupon),
    couponId: coupon?.id ?? null,
    discountDisplay: formatDiscountDisplay(discountType, discountValue, maxDiscount),
  };
}
