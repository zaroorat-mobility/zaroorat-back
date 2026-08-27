export type DiscountType = 'PERCENT' | 'FIXED';

export interface SegmentRules {
  cityCodes?: string[];
  vehicleTypeIds?: string[];
  firstRideOnly?: boolean;
  userIds?: string[];
}

export interface PromoEligibilityContext {
  userId?: string;
  cityCode?: string | null;
  vehicleTypeId?: string | null;
  subtotal: number;
  /** When true, skip first-ride checks that need a userId (quote without auth). */
  softUserChecks?: boolean;
}

export interface ResolvedPromo {
  promotionId: string;
  code: string;
  title: string | null;
  discountType: DiscountType;
  discountValue: number;
  maxDiscount: number | null;
  minFare: number;
  couponId: string | null;
  discountAmount: number;
}

export interface PromoQuoteResult {
  applied: boolean;
  discountAmount: number;
  promo: ResolvedPromo | null;
  errorCode?: string;
  errorMessage?: string;
}
