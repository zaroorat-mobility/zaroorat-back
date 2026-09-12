import { createHmac, timingSafeEqual } from 'node:crypto';
import { Decimal } from '../../modules/payments/types/index.js';
import type {
  PaymentGatewayProvider,
  CreateGatewayIntentInput,
  GatewayIntentResult,
  GatewayRefundResult,
  GatewayPayoutResult,
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

interface RazorpayPaymentResponse {
  id: string;
  order_id: string;
  status: string;
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
    const order = await this.request<RazorpayOrderResponse>('POST', '/orders', {
      amount: amountPaise,
      currency: input.currency,
      receipt: input.idempotencyKey,
      notes: input.metadata ?? {},
    });
    return {
      gatewayIntentId: order.id,
      status: mapOrderStatus(order.status),
    };
  }

  async confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult> {
    // An Order has no single terminal status of its own once paid — the
    // payment attached to it does. `payments?order_id=` returns every attempt;
    // the most recent captured/authorized one (if any) is authoritative.
    const list = await this.request<{ items: RazorpayPaymentResponse[] }>(
      'GET',
      `/payments?order_id=${encodeURIComponent(gatewayIntentId)}`,
    );
    const authoritative =
      list.items.find((p) => p.status === 'captured') ??
      list.items.find((p) => p.status === 'authorized') ??
      list.items.find((p) => p.status === 'failed') ??
      list.items[0];
    if (!authoritative) {
      return { gatewayIntentId, status: 'PENDING' };
    }
    return { gatewayIntentId, status: mapPaymentStatus(authoritative.status) };
  }

  async createRefund(
    transactionId: string,
    amount: Decimal,
    idempotencyKey: string,
  ): Promise<GatewayRefundResult> {
    const amountPaise = amount.mul(100).toDecimalPlaces(0).toNumber();
    const refund = await this.request<{ id: string; status: string }>(
      'POST',
      `/payments/${encodeURIComponent(transactionId)}/refund`,
      { amount: amountPaise, notes: { idempotencyKey } },
    );
    return {
      gatewayRefundId: refund.id,
      status: refund.status === 'processed' ? 'SUCCEEDED' : 'PENDING',
    };
  }

  /// RazorpayX Payouts — a distinct product from Orders/Payments, requiring a
  /// funded RazorpayX account and a `fund_account_id` rather than a raw bank
  /// account id. `bankAccountId` here is expected to already BE a RazorpayX
  /// fund account id (resolving a raw bank account to one is an account-setup
  /// concern outside payment collection, and belongs wherever driver bank
  /// accounts are provisioned against RazorpayX, not in this call).
  async createPayout(
    _driverId: string,
    bankAccountId: string,
    amount: Decimal,
    idempotencyKey: string,
  ): Promise<GatewayPayoutResult> {
    const amountPaise = amount.mul(100).toDecimalPlaces(0).toNumber();
    const payout = await this.request<{ id: string; status: string }>('POST', '/payouts', {
      account_number: bankAccountId,
      fund_account_id: bankAccountId,
      amount: amountPaise,
      currency: 'INR',
      mode: 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: idempotencyKey,
    });
    return {
      gatewayPayoutId: payout.id,
      status: payout.status === 'processed' ? 'COMPLETED' : 'PENDING',
    };
  }
}

function mapOrderStatus(status: string): string {
  if (status === 'paid') return 'SUCCEEDED';
  if (status === 'attempted') return 'PENDING';
  return 'PENDING';
}

function mapPaymentStatus(status: string): string {
  if (status === 'captured') return 'SUCCEEDED';
  if (status === 'failed') return 'FAILED';
  return 'PENDING';
}

/// Server-side verification of a Razorpay Checkout success callback —
/// spec section 7's "verify Checkout payment signature server-side".
/// signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret), hex.
/// No route currently calls this (checkout confirmation in this codebase is
/// webhook-driven end-to-end, not a client-posted callback) — exported so a
/// client-callback endpoint can use it the moment one is added, without
/// re-deriving Razorpay's signature formula.
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
