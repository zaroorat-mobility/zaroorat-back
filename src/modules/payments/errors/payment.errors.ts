export class PaymentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'PAYMENT_ERROR', statusCode = 400) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class InsufficientBalanceError extends PaymentError {
  constructor(message = 'Insufficient wallet balance for this operation') {
    super(message, 'INSUFFICIENT_BALANCE', 402);
    this.name = 'InsufficientBalanceError';
  }
}
export class InvalidStateTransitionError extends PaymentError {
  constructor(fromState: string, toState: string) {
    super(
      `Cannot transition payment state from ${fromState} to ${toState}`,
      'INVALID_STATE_TRANSITION',
      409,
    );
    this.name = 'InvalidStateTransitionError';
  }
}
export class DuplicateIdempotencyKeyError extends PaymentError {
  constructor(message = 'An operation with this Idempotency-Key has different payload parameters') {
    super(message, 'DUPLICATE_IDEMPOTENCY_KEY', 409);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}
export class GatewayError extends PaymentError {
  readonly gateway: string;
  constructor(message: string, gateway = 'UNKNOWN') {
    super(`Gateway ${gateway} error: ${message}`, 'GATEWAY_ERROR', 502);
    this.name = 'GatewayError';
    this.gateway = gateway;
  }
}
export class RefundNotAllowedError extends PaymentError {
  constructor(message = 'Refund exceeds refundable amount or payment is not captured') {
    super(message, 'REFUND_NOT_ALLOWED', 422);
    this.name = 'RefundNotAllowedError';
  }
}
export class PaymentNotFoundError extends PaymentError {
  constructor(id: string) {
    super(`Payment intent or record with ID '${id}' was not found`, 'PAYMENT_NOT_FOUND', 404);
    this.name = 'PaymentNotFoundError';
  }
}
export class WebhookSignatureError extends PaymentError {
  constructor(message = 'Invalid webhook HMAC signature') {
    super(message, 'WEBHOOK_SIGNATURE_INVALID', 401);
    this.name = 'WebhookSignatureError';
  }
}
export class WebhookEventIdMissingError extends PaymentError {
  constructor(message = 'Webhook payload carried no gateway event id; it cannot be deduplicated') {
    super(message, 'WEBHOOK_EVENT_ID_MISSING', 400);
    this.name = 'WebhookEventIdMissingError';
  }
}
export class WebhookReplayError extends PaymentError {
  constructor(ageSeconds: number, toleranceSeconds: number) {
    super(
      `Webhook timestamp is ${ageSeconds}s from now, outside the ${toleranceSeconds}s tolerance`,
      'WEBHOOK_REPLAY_REJECTED',
      400,
    );
    this.name = 'WebhookReplayError';
  }
}
export class IdempotencyKeyRequiredError extends PaymentError {
  constructor(message = 'An Idempotency-Key header is required for this operation') {
    super(message, 'IDEMPOTENCY_KEY_REQUIRED', 400);
    this.name = 'IdempotencyKeyRequiredError';
  }
}
export class PayoutUnbackedError extends PaymentError {
  constructor(message = 'A payout must reference a settlement that establishes the amount owed') {
    super(message, 'PAYOUT_UNBACKED', 422);
    this.name = 'PayoutUnbackedError';
  }
}
export class PayoutExceedsAvailableError extends PaymentError {
  constructor(requested: string, available: string) {
    super(
      `Payout of ${requested} exceeds the ${available} still available on this settlement`,
      'PAYOUT_EXCEEDS_AVAILABLE',
      422,
    );
    this.name = 'PayoutExceedsAvailableError';
  }
}
export class InvalidPayoutAmountError extends PaymentError {
  constructor(message = 'Payout amount must be greater than zero') {
    super(message, 'INVALID_PAYOUT_AMOUNT', 400);
    this.name = 'InvalidPayoutAmountError';
  }
}
export class LedgerImbalanceError extends PaymentError {
  constructor(debitSum: number, creditSum: number) {
    super(
      `Ledger entry group imbalance: Debits (${debitSum}) != Credits (${creditSum})`,
      'LEDGER_IMBALANCE',
      500,
    );
    this.name = 'LedgerImbalanceError';
  }
}

/// Feature 002 — ride collection, receivables and cash confirmation.
///
/// All extend PaymentError so `handlePaymentError` surfaces them with their
/// real code and status; nothing about the envelope changes.

export class RidePaymentNotFoundError extends PaymentError {
  constructor(rideId: string) {
    super(`No payment record for ride "${rideId}"`, 'RIDE_PAYMENT_NOT_FOUND', 404);
    this.name = 'RidePaymentNotFoundError';
  }
}

export class CollectionNotRetryableError extends PaymentError {
  constructor(message = 'This ride has no outstanding amount to settle') {
    super(message, 'COLLECTION_NOT_RETRYABLE', 409);
    this.name = 'CollectionNotRetryableError';
  }
}

/// BD-1c: "outstanding until collected **or** written off" — a written-off
/// receivable is no longer outstanding, so it can no longer be settled.
/// Recovery of written-off debt is a separate flow, not in V1.
export class ObligationWrittenOffError extends PaymentError {
  constructor(message = 'This obligation was written off and can no longer be settled') {
    super(message, 'OBLIGATION_WRITTEN_OFF', 409);
    this.name = 'ObligationWrittenOffError';
  }
}

export class CashConfirmationNotApplicableError extends PaymentError {
  constructor(message = 'This ride is not awaiting cash confirmation') {
    super(message, 'CASH_CONFIRMATION_NOT_APPLICABLE', 409);
    this.name = 'CashConfirmationNotApplicableError';
  }
}

/// BD-2. Raised only when creating a NEW ride request — never when settling an
/// existing obligation, because refusing someone permission to pay you is
/// self-defeating.
export class RiderDebtLimitExceededError extends PaymentError {
  constructor(outstanding: string, limit: string) {
    super(
      `Outstanding balance of ${outstanding} reaches the ${limit} limit. ` +
        'Settle an unpaid ride to request a new one.',
      'RIDER_DEBT_LIMIT_EXCEEDED',
      409,
    );
    this.name = 'RiderDebtLimitExceededError';
  }
}
