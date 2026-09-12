export type GatewayWebhookPayload = Record<string, unknown> | null | undefined;

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
  return {
    eventId: asNonEmptyString(pick(payload, 'id')),
    eventType,
    intentReference:
      asNonEmptyString(pick(payload, 'data', 'object', 'payment_intent')) ??
      asNonEmptyString(pick(payload, 'data', 'object', 'id')),
    gatewayTxnId:
      asNonEmptyString(pick(payload, 'data', 'object', 'latest_charge')) ??
      asNonEmptyString(pick(payload, 'data', 'object', 'id')),
    timestampSeconds: normaliseTimestamp(pick(payload, 'created')),
    outcome,
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
  const paymentId = asNonEmptyString(pick(payload, 'payload', 'payment', 'entity', 'id'));
  const orderId = asNonEmptyString(pick(payload, 'payload', 'payment', 'entity', 'order_id'));
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
  };
}
