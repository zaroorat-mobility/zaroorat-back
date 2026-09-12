export class SubscriptionError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'SUBSCRIPTION_ERROR', statusCode = 400) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class SubscriptionPlanNotFoundError extends SubscriptionError {
  constructor(id: string) {
    super(`Subscription plan '${id}' was not found or is not active`, 'PLAN_NOT_FOUND', 404);
    this.name = 'SubscriptionPlanNotFoundError';
  }
}
/// spec.md Assumptions — a driver has at most one active subscription at a
/// time; this is the DB-level backstop's application-facing counterpart
/// (driver_subscriptions_one_active).
export class SubscriptionAlreadyActiveError extends SubscriptionError {
  constructor() {
    super('You already have an active subscription', 'SUBSCRIPTION_ALREADY_ACTIVE', 409);
    this.name = 'SubscriptionAlreadyActiveError';
  }
}
export class SubscriptionNotFoundError extends SubscriptionError {
  constructor() {
    super('No subscription found for this driver', 'SUBSCRIPTION_NOT_FOUND', 404);
    this.name = 'SubscriptionNotFoundError';
  }
}
