export class PromotionError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'PROMO_ERROR', statusCode = 400) {
    super(message);
    this.name = 'PromotionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PromoCodeNotFoundError extends PromotionError {
  constructor(message = 'Promo code was not found') {
    super(message, 'PROMO_NOT_FOUND', 404);
    this.name = 'PromoCodeNotFoundError';
  }
}

export class PromoCodeInvalidError extends PromotionError {
  constructor(message: string, code = 'PROMO_INVALID') {
    super(message, code, 400);
    this.name = 'PromoCodeInvalidError';
  }
}

export class PromoNotEligibleError extends PromotionError {
  constructor(message: string) {
    super(message, 'PROMO_NOT_ELIGIBLE', 400);
    this.name = 'PromoNotEligibleError';
  }
}

/// The promotion's total or per-user cap was reached, decided by the database at
/// the moment of redemption rather than by a read taken minutes earlier at
/// booking. Distinct from `PromoCodeInvalidError` so a caller can tell "this code
/// is finished" from "this code was never valid".
export class PromoLimitReachedError extends PromotionError {
  constructor(message = 'This promotion has reached its usage limit') {
    super(message, 'PROMO_LIMIT_REACHED', 409);
    this.name = 'PromoLimitReachedError';
  }
}
