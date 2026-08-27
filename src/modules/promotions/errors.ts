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
