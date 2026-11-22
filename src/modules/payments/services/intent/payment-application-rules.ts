import type { ProviderPayment } from '../gateway/gateway.provider.js';
import type { ReviewCaseKind } from '../../constants/payment.constants.js';

/// 005-razorpay-driver-payments T024: spec.md "Payment application rules" as
/// one pure decision. Every path that can move money (verify, webhook,
/// reconciliation, sweep, staff confirm) calls it inside the intent lock and
/// carries out the decision (INV-9). It reads only provider data and our own
/// rows; nothing a client sends decides success.

export type GatePath = 'VERIFY' | 'WEBHOOK' | 'RECONCILIATION' | 'SWEEP' | 'STAFF_CONFIRM';
export type GateProvider =
  /// Timeout, 5xx, 429 or an unusable payload: nothing is decided (INV-8).
  | { kind: 'unknown' }
  | {
      kind: 'payment';
      payment: Pick<ProviderPayment, 'id' | 'orderId' | 'amountPaise' | 'currency' | 'status'>;
      /// `order.paid` only: `payload.order.entity.amount_paid`, which must also
      /// equal the expected amount.
      orderAmountPaidPaise?: number;
    };
export interface GateInput {
  path: GatePath;
  /// null: the order is not one we created (A9).
  intent: {
    status: string;
    orderId: string;
    amountPaise: number;
    currency: string;
    /// The `pay_…` id of this intent's SUCCEEDED payment row, if any.
    succeededPaymentId: string | null;
  } | null;
  provider: GateProvider;
  /// This `pay_…` id is already SUCCEEDED on a different intent.
  paymentAppliedElsewhere: boolean;
  /// This `pay_…` id is already held (CAPTURED_REVIEW) on this intent.
  paymentHeldOnIntent?: boolean;
  /// For `refunded`: a Zaroorat refund explains it.
  refundRecorded?: boolean;
  /// Driver `verify` path only.
  verify?: { callerOwnsIntent: boolean; signatureValid: boolean; callbackOrderId: string };
}
export type GateRule =
  'UNKNOWN' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A9' | 'A10' | 'A11' | 'A12';
export interface GateDecision {
  rule: GateRule;
  outcome: 'REJECT' | 'NO_CHANGE' | 'MARK_FAILED' | 'APPLY' | 'REVIEW' | 'NO_OP';
  reviewKind?: ReviewCaseKind;
  /// The intent status after the decision; absent when it does not change.
  intentStatusAfter?: string;
  /// A4 on an EXPIRED intent.
  alert?: boolean;
}

// data-model.md §2 source statuses.
const APPLY_FROM = new Set(['PENDING', 'PROCESSING', 'FAILED', 'EXPIRED']);
const FAIL_FROM = new Set(['PENDING', 'PROCESSING']);
const REVIEW_FROM = new Set(['PENDING', 'PROCESSING', 'FAILED', 'EXPIRED', 'CANCELLED']);

/// Evaluation order of spec.md; the first match wins.
export function decidePaymentApplication(input: GateInput): GateDecision {
  const { intent, provider } = input;

  // 1. A1: ownership, checkout signature and callback order, verify path only.
  if (input.path === 'VERIFY') {
    const v = input.verify;
    if (!v || !intent || !v.callerOwnsIntent || !v.signatureValid) {
      return { rule: 'A1', outcome: 'REJECT' };
    }
    if (v.callbackOrderId !== intent.orderId) return { rule: 'A1', outcome: 'REJECT' };
  }

  // 2. No provider record: unknown, never FAILED.
  if (provider.kind === 'unknown') return { rule: 'UNKNOWN', outcome: 'NO_CHANGE' };
  const payment = provider.payment;

  // 3. A9: not our order. Only money we hold needs a case.
  if (!intent) {
    return payment.status === 'captured'
      ? { rule: 'A9', outcome: 'REVIEW', reviewKind: 'UNKNOWN_ORDER' }
      : { rule: 'A9', outcome: 'NO_OP' };
  }

  // 4. Not captured.
  if (payment.status === 'created' || payment.status === 'authorized') {
    return { rule: 'A2', outcome: 'NO_CHANGE' };
  }
  if (payment.status === 'failed') {
    if (intent.status === 'SUCCEEDED') return { rule: 'A12', outcome: 'NO_OP' };
    return FAIL_FROM.has(intent.status)
      ? { rule: 'A3', outcome: 'MARK_FAILED', intentStatusAfter: 'FAILED' }
      : { rule: 'A3', outcome: 'NO_CHANGE' };
  }
  if (payment.status === 'refunded') {
    // A case only; the intent keeps its status (data-model §2 lists no A10 move).
    return input.refundRecorded
      ? { rule: 'A10', outcome: 'NO_OP' }
      : { rule: 'A10', outcome: 'REVIEW', reviewKind: 'EXTERNAL_REFUND' };
  }

  // 5. Captured. A review leaves a SUCCEEDED intent SUCCEEDED (A6, A7).
  const review = (rule: GateRule, reviewKind: ReviewCaseKind): GateDecision => ({
    rule,
    outcome: 'REVIEW',
    reviewKind,
    ...(REVIEW_FROM.has(intent.status) ? { intentStatusAfter: 'MANUAL_REVIEW' } : {}),
  });
  // Decision R1 (2026-10-21): another order's payment never touches this
  // intent. The caller routes it to the intent that owns its order (or to an
  // UNKNOWN_ORDER case); verify rejects it before reaching here.
  if (payment.orderId !== intent.orderId) return { rule: 'A5', outcome: 'REJECT' };
  if (
    payment.amountPaise !== intent.amountPaise ||
    (provider.orderAmountPaidPaise !== undefined &&
      provider.orderAmountPaidPaise !== intent.amountPaise)
  ) {
    return review('A5', 'AMOUNT_MISMATCH');
  }
  if (payment.currency !== intent.currency) return review('A5', 'CURRENCY_MISMATCH');
  if (intent.succeededPaymentId === payment.id || input.paymentHeldOnIntent) {
    return { rule: 'A11', outcome: 'NO_OP' };
  }
  if (input.paymentAppliedElsewhere) return review('A6', 'PAYMENT_ID_REUSED');
  if (intent.status === 'SUCCEEDED' || intent.succeededPaymentId) {
    return review('A7', 'MULTIPLE_CAPTURES');
  }
  if (intent.status === 'CANCELLED') return review('A8', 'UNMATCHED_CAPTURE');
  if (APPLY_FROM.has(intent.status)) {
    return {
      rule: 'A4',
      outcome: 'APPLY',
      intentStatusAfter: 'SUCCEEDED',
      ...(intent.status === 'EXPIRED' ? { alert: true } : {}),
    };
  }
  // MANUAL_REVIEW (or a historical status): a further capture is held too;
  // only a Finance resolution moves the intent (UD-1).
  return review('A7', 'MULTIPLE_CAPTURES');
}
