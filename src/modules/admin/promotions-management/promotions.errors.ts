export class PromotionsAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'PROMOTIONS_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'PromotionsAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PromotionNotFoundError extends PromotionsAdminError {
  constructor(message = 'Promotion was not found') {
    super(message, 'PROMOTION_NOT_FOUND', 404);
    this.name = 'PromotionNotFoundError';
  }
}

export class PromotionConflictError extends PromotionsAdminError {
  constructor(message: string) {
    super(message, 'PROMOTION_CONFLICT', 409);
    this.name = 'PromotionConflictError';
  }
}

export class CampaignNotFoundError extends PromotionsAdminError {
  constructor(message = 'Campaign was not found') {
    super(message, 'CAMPAIGN_NOT_FOUND', 404);
    this.name = 'CampaignNotFoundError';
  }
}

export class CampaignConflictError extends PromotionsAdminError {
  constructor(message: string) {
    super(message, 'CAMPAIGN_CONFLICT', 409);
    this.name = 'CampaignConflictError';
  }
}

export class SegmentNotFoundError extends PromotionsAdminError {
  constructor(message = 'Audience segment was not found') {
    super(message, 'SEGMENT_NOT_FOUND', 404);
    this.name = 'SegmentNotFoundError';
  }
}

export class SegmentConflictError extends PromotionsAdminError {
  constructor(message: string) {
    super(message, 'SEGMENT_CONFLICT', 409);
    this.name = 'SegmentConflictError';
  }
}

export class CouponBatchNotFoundError extends PromotionsAdminError {
  constructor(message = 'Coupon batch was not found') {
    super(message, 'COUPON_BATCH_NOT_FOUND', 404);
    this.name = 'CouponBatchNotFoundError';
  }
}

export class BannerNotFoundError extends PromotionsAdminError {
  constructor(message = 'Promo banner was not found') {
    super(message, 'BANNER_NOT_FOUND', 404);
    this.name = 'BannerNotFoundError';
  }
}
