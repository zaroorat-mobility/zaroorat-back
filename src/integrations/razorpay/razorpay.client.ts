import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  selectOrderPayments,
  type PaymentGatewayProvider,
  type CreateGatewayIntentInput,
  type GatewayIntentResult,
  type GatewayRefundResult,
  type CreateGatewayRefundInput,
  type OrderPayments,
  type ProviderPayment,
  type ProviderPaymentStatus,
} from '../../modules/payments/services/gateway/gateway.provider.js';

const SANDBOX_BASE_URL = 'https://api.razorpay.com/v1';
const LIVE_BASE_URL = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly gatewayCode?: string | undefined,
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

interface RazorpayOrderResponse {
  id: string;
  status: string;
}

interface RazorpayPaymentEntity {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  captured?: boolean;
  method?: string | null;
  created_at?: number;
}

/// Sweep page size; Razorpay's documented maximum for `count`.
export const RAZORPAY_LIST_PAGE_SIZE = 100;

/// decisions.md TD-3: `zr1_` + the first 32 hex chars of SHA-256(scoped key).
/// 36 ASCII chars, inside the documented 40-char limit, where the raw scoped
/// key (`recharge:{driverId}:{key}`) is not. Deterministic, for traceability
/// only: sandbox S2c showed Razorpay accepts a reused receipt, so it is not an
/// idempotency guarantee.
export function razorpayReceipt(scopedIdempotencyKey: string): string {
  return `zr1_${createHash('sha256').update(scopedIdempotencyKey).digest('hex').slice(0, 32)}`;
}

interface RazorpayErrorBody {
  error?: { description?: string; code?: string };
}

/// Real Razorpay Orders/Payments API integration. Auth is HTTP Basic with
/// key_id:key_secret — Razorpay's own convention, not a bearer token.
export class RazorpayGatewayProvider implements PaymentGatewayProvider {
  readonly gatewayName = 'razorpay';
  private readonly baseUrl: string;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    environment: 'sandbox' | 'live' = 'sandbox',
  ) {
    if (!keyId || !keySecret) {
      throw new Error('RazorpayGatewayProvider requires both a key id and a key secret');
    }
    // Razorpay does not expose distinct sandbox/live hostnames — test vs live
    // mode is selected by which key pair (rzp_test_*/rzp_live_*) is used, so
    // `environment` only ever picks between two identical base URLs today.
    // Kept as a real branch (not a no-op) so a future distinct sandbox host
    // does not require touching every call site again.
    this.baseUrl = environment === 'live' ? LIVE_BASE_URL : SANDBOX_BASE_URL;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : {};
      if (!res.ok) {
        const errBody = json as RazorpayErrorBody;
        throw new RazorpayApiError(
          errBody.error?.description ?? `Razorpay request failed with status ${res.status}`,
          res.status,
          errBody.error?.code,
        );
      }
      return json as T;
    } catch (err) {
      if (err instanceof RazorpayApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RazorpayApiError(`Razorpay request to ${path} timed out`, 504);
      }
      throw new RazorpayApiError(
        err instanceof Error ? err.message : 'Razorpay request failed',
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async createIntent(input: CreateGatewayIntentInput): Promise<GatewayIntentResult> {
    // Amounts are paise-integer at the API boundary; Decimal is rupees
    // everywhere else in this codebase (RideFareSplit, PaymentIntent.amount).
    const amountPaise = input.amount.mul(100).toDecimalPlaces(0).toNumber();
    // A 400 here is a plain gateway error: the receipt-lookup recovery was
    // withdrawn after sandbox S2c/S2d (contracts/razorpay-provider.md §1).
    const order = await this.request<RazorpayOrderResponse>('POST', '/orders', {
      amount: amountPaise,
      currency: input.currency,
      receipt: razorpayReceipt(input.idempotencyKey),
      notes: input.metadata ?? {},
      // One payment per order; Razorpay allows more only when this is true.
      partial_payment: false,
    });
    return {
      gatewayIntentId: order.id,
      status: mapOrderStatus(order.status),
    };
  }

  async confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult> {
    const { kind, payment } = await this.fetchOrderPayments(gatewayIntentId);
    return {
      gatewayIntentId,
      status: kind === 'captured' ? 'SUCCEEDED' : kind === 'failed' ? 'FAILED' : 'PENDING',
      ...(payment ? { providerPaymentId: payment.id } : {}),
    };
  }

  /// Documented `GET /orders/{id}/payments` (TD-2). It replaces an undocumented
  /// order-id filter on `GET /payments` that stored the order id as the
  /// payment id (research.md CD-1).
  async fetchOrderPayments(orderId: string): Promise<OrderPayments> {
    const list = await this.request<{ items: RazorpayPaymentEntity[] }>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return selectOrderPayments(orderId, list.items.map(normalisePayment));
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    return normalisePayment(
      await this.request<RazorpayPaymentEntity>(
        'GET',
        `/payments/${encodeURIComponent(paymentId)}`,
      ),
    );
  }

  async listPayments(from: Date, to: Date, skip: number): Promise<ProviderPayment[]> {
    const query = new URLSearchParams({
      from: String(Math.floor(from.getTime() / 1000)),
      to: String(Math.floor(to.getTime() / 1000)),
      count: String(RAZORPAY_LIST_PAGE_SIZE),
      skip: String(skip),
    });
    const list = await this.request<{ items: RazorpayPaymentEntity[] }>(
      'GET',
      `/payments?${query.toString()}`,
    );
    return list.items.map(normalisePayment);
  }

  checkoutKeyId(): string {
    return this.keyId;
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return verifyRazorpayPaymentSignature(orderId, paymentId, signature, this.keySecret);
  }

  /// `providerPaymentId` is the Razorpay payment id (`pay_...`). This used to be
  /// our internal PaymentTransaction UUID, which Razorpay rejects, so every real
  /// refund failed. Our refund id travels as `receipt` and in `notes` so
  /// `findRefund` can recover the refund after a timeout. Razorpay refunds have
  /// no idempotency header, so find-before-create (in RefundService) is what
  /// stops a retry from refunding twice.
  async createRefund(input: CreateGatewayRefundInput): Promise<GatewayRefundResult> {
    const amountPaise = input.amount.mul(100).toDecimalPlaces(0).toNumber();
    const refund = await this.request<RazorpayRefundEntity>(
      'POST',
      `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        amount: amountPaise,
        receipt: input.refundReference,
        notes: { refund_reference: input.refundReference },
      },
    );
    return { gatewayRefundId: refund.id, status: mapRazorpayRefundStatus(refund.status) };
  }

  async findRefund(
    providerPaymentId: string,
    refundReference: string,
  ): Promise<GatewayRefundResult | null> {
    const list = await this.request<{ items: RazorpayRefundEntity[] }>(
      'GET',
      `/payments/${encodeURIComponent(providerPaymentId)}/refunds?count=100`,
    );
    const match = list.items.find(
      (r) => r.notes?.refund_reference === refundReference || r.receipt === refundReference,
    );
    return match
      ? { gatewayRefundId: match.id, status: mapRazorpayRefundStatus(match.status) }
      : null;
  }
}

interface RazorpayRefundEntity {
  id: string;
  status: string;
  receipt?: string | null;
  notes?: Record<string, string> | null;
}

function mapRazorpayRefundStatus(status: string): 'SUCCEEDED' | 'PENDING' | 'FAILED' {
  if (status === 'processed') return 'SUCCEEDED';
  if (status === 'failed') return 'FAILED';
  return 'PENDING';
}

function mapOrderStatus(status: string): string {
  if (status === 'paid') return 'SUCCEEDED';
  if (status === 'attempted') return 'PENDING';
  return 'PENDING';
}

function normalisePayment(p: RazorpayPaymentEntity): ProviderPayment {
  return {
    id: p.id,
    orderId: p.order_id ?? '',
    amountPaise: p.amount,
    currency: String(p.currency ?? '').toUpperCase(),
    status: normaliseStatus(p),
    method: p.method ?? null,
    createdAt: typeof p.created_at === 'number' ? new Date(p.created_at * 1000) : null,
  };
}

/// An authorisation Razorpay auto-refunded at the capture timeout is
/// `refunded` with `captured: false`: no money was ever taken, so for us it is
/// a failed attempt, not an external refund (data-model §9).
function normaliseStatus(p: RazorpayPaymentEntity): ProviderPaymentStatus {
  if (p.status === 'refunded' && p.captured === false) return 'failed';
  if (['created', 'authorized', 'captured', 'failed', 'refunded'].includes(p.status)) {
    return p.status as ProviderPaymentStatus;
  }
  // Undocumented status: never treat it as money received.
  return 'created';
}

/// Server-side verification of a Razorpay Checkout success callback —
/// spec section 7's "verify Checkout payment signature server-side".
/// signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret), hex.
/// Used through `RazorpayGatewayProvider.verifyCheckoutSignature` by
/// `POST /payments/intents/:intentId/verify` (005 T043). A valid signature
/// proves the callback came from checkout for that order, never that money
/// was captured: verify still fetches the payment and runs the gate.
export function verifyRazorpayPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  if (!signature || !keySecret) return false;
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return timingSafeCompare(signature, expected);
}

/// Razorpay webhook signature: HMAC-SHA256 of the raw request body (not the
/// parsed JSON) with the webhook secret, hex-encoded, sent in
/// `X-Razorpay-Signature`. Distinct function from the generic verifier this
/// replaces — kept provider-specific per spec section 7/9.
export function verifyRazorpayWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
): boolean {
  if (!signature || !webhookSecret) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return timingSafeCompare(signature, expected);
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
