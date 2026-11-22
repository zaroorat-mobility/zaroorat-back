import type {
  ProviderPayment,
  ProviderPaymentStatus,
} from '../services/gateway/gateway.provider.js';

export type GatewayWebhookPayload = Record<string, unknown> | null | undefined;
/// What the validation gate reads from a signed payload.
export type WebhookPayment = Pick<
  ProviderPayment,
  'id' | 'orderId' | 'amountPaise' | 'currency' | 'status'
>;

export interface ParsedWebhookEvent {
  eventId: string | null;
  eventType: string;
  /// Reference this webhook's provider order/intent id — resolved against
  /// `PaymentIntent.gatewayIntentId` (or the intent id itself as a fallback).
  intentReference: string | null;
  gatewayTxnId: string | null;
  timestampSeconds: number | null;
  /// null = not a payment-outcome event this pipeline needs to act on
  /// (e.g. a Stripe `charge.dispute.created`) — persisted for idempotency,
  /// but never fed into `IntentService.applyConfirmation`.
  outcome: 'SUCCEEDED' | 'FAILED' | null;
  /// The payment as a provider record for the validation gate (005 T024).
  /// null when a field the gate needs is missing or malformed: nothing is
  /// then applied, and reconciliation settles the payment from provider truth.
  payment: WebhookPayment | null;
  /// Razorpay `order.paid` only: `payload.order.entity.amount_paid`.
  orderAmountPaidPaise?: number;
}

function pick(source: GatewayWebhookPayload, ...path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/// Integer paise (Razorpay) or minor units (Stripe). A string, a fraction or
/// a negative number is malformed, not something to coerce.
function asMinorUnits(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asCurrency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

const PAYMENT_STATUSES = new Set(['created', 'authorized', 'captured', 'failed', 'refunded']);

function gatePayment(fields: {
  id: string | null;
  orderId: string | null;
  amount: unknown;
  currency: unknown;
  status: ProviderPaymentStatus | null;
}): WebhookPayment | null {
  const amountPaise = asMinorUnits(fields.amount);
  const currency = asCurrency(fields.currency);
  if (!fields.id || !fields.orderId || amountPaise === null || !currency || !fields.status) {
    return null;
  }
  return { id: fields.id, orderId: fields.orderId, amountPaise, currency, status: fields.status };
}

/// Both epoch-seconds and epoch-milliseconds arrive from different providers
/// (and different event vintages of the same provider) — normalises to seconds.
function normaliseTimestamp(raw: unknown): number | null {
  const n = asNumber(raw);
  if (n != null && n > 0) return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

/// Stripe's real webhook envelope: `{id, type, created, data: {object: {id, ...}}}`.
const STRIPE_SUCCESS_TYPES = new Set(['payment_intent.succeeded', 'charge.succeeded']);
const STRIPE_FAILURE_TYPES = new Set([
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.failed',
]);

export function parseStripeWebhook(payload: GatewayWebhookPayload): ParsedWebhookEvent {
  const eventType = String(pick(payload, 'type') ?? '');
  const outcome = STRIPE_SUCCESS_TYPES.has(eventType)
    ? 'SUCCEEDED'
    : STRIPE_FAILURE_TYPES.has(eventType)
      ? 'FAILED'
      : null;
  const intentReference =
    asNonEmptyString(pick(payload, 'data', 'object', 'payment_intent')) ??
    asNonEmptyString(pick(payload, 'data', 'object', 'id'));
  const gatewayTxnId =
    asNonEmptyString(pick(payload, 'data', 'object', 'latest_charge')) ??
    asNonEmptyString(pick(payload, 'data', 'object', 'id'));
  return {
    eventId: asNonEmptyString(pick(payload, 'id')),
    eventType,
    intentReference,
    gatewayTxnId,
    timestampSeconds: normaliseTimestamp(pick(payload, 'created')),
    outcome,
    // A PaymentIntent reports `amount_received`; a charge only `amount`.
    payment: gatePayment({
      id: gatewayTxnId,
      orderId: intentReference,
      amount:
        pick(payload, 'data', 'object', 'amount_received') ??
        pick(payload, 'data', 'object', 'amount'),
      currency: pick(payload, 'data', 'object', 'currency'),
      status: outcome === 'SUCCEEDED' ? 'captured' : outcome === 'FAILED' ? 'failed' : null,
    }),
  };
}

/// Razorpay's real webhook envelope: top-level `event` (e.g.
/// `"payment.captured"`), the payment under `payload.payment.entity`, the
/// order id nested at `payload.payment.entity.order_id`. Razorpay does not
/// put a stable event id in the body at all — it is delivered ONLY in the
/// `X-Razorpay-Event-Id` header, so `eventIdHeader` must be threaded through
/// from the raw request by the caller.
const RAZORPAY_SUCCESS_EVENTS = new Set(['payment.captured', 'order.paid']);
const RAZORPAY_FAILURE_EVENTS = new Set(['payment.failed']);

export function parseRazorpayWebhook(
  payload: GatewayWebhookPayload,
  eventIdHeader: string | null,
): ParsedWebhookEvent {
  const eventType = String(pick(payload, 'event') ?? '');
  const outcome = RAZORPAY_SUCCESS_EVENTS.has(eventType)
    ? 'SUCCEEDED'
    : RAZORPAY_FAILURE_EVENTS.has(eventType)
      ? 'FAILED'
      : null;
  const entity = (key: string) => pick(payload, 'payload', 'payment', 'entity', key);
  const paymentId = asNonEmptyString(entity('id'));
  const orderId = asNonEmptyString(entity('order_id'));
  const rawStatus = entity('status');
  // An authorisation auto-refunded at the capture timeout never took money
  // (same rule as the adapter, data-model §9).
  const status =
    typeof rawStatus !== 'string' || !PAYMENT_STATUSES.has(rawStatus)
      ? null
      : rawStatus === 'refunded' && entity('captured') === false
        ? 'failed'
        : (rawStatus as ProviderPaymentStatus);
  const payment = gatePayment({
    id: paymentId,
    orderId,
    amount: entity('amount'),
    currency: entity('currency'),
    status,
  });
  // `order.paid` must also carry a well-formed `amount_paid`, which the gate
  // compares with the expected amount.
  const amountPaid =
    eventType === 'order.paid'
      ? asMinorUnits(pick(payload, 'payload', 'order', 'entity', 'amount_paid'))
      : undefined;
  return {
    // Falls back to `orderId:paymentId` only when the header is missing
    // (e.g. a hand-built test payload) — a real Razorpay delivery always
    // carries the header, and this fallback is not itself a substitute for
    // the header's guarantee.
    eventId: eventIdHeader ?? (orderId && paymentId ? `${orderId}:${paymentId}` : paymentId),
    eventType,
    intentReference: orderId,
    gatewayTxnId: paymentId,
    timestampSeconds: normaliseTimestamp(pick(payload, 'created_at')),
    outcome,
    payment: amountPaid === null ? null : payment,
    ...(amountPaid != null ? { orderAmountPaidPaise: amountPaid } : {}),
  };
}
