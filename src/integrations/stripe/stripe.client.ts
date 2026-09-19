import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PaymentGatewayProvider,
  CreateGatewayIntentInput,
  GatewayIntentResult,
  GatewayRefundResult,
  CreateGatewayRefundInput,
} from '../../modules/payments/services/gateway/gateway.provider.js';

const BASE_URL = 'https://api.stripe.com/v1';
const API_VERSION = '2024-06-20';
const REQUEST_TIMEOUT_MS = 15_000;

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly gatewayCode?: string | undefined,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

interface StripePaymentIntentResponse {
  id: string;
  status: string;
  client_secret?: string;
}

interface StripeErrorBody {
  error?: { message?: string; code?: string };
}

/// Real Stripe PaymentIntents API integration. Auth is a Bearer token (the
/// secret key); requests are form-encoded, per Stripe's API convention (not
/// JSON) — sending JSON here silently drops nested fields.
export class StripeGatewayProvider implements PaymentGatewayProvider {
  readonly gatewayName = 'stripe';

  constructor(private readonly secretKey: string) {
    if (!secretKey) {
      throw new Error('StripeGatewayProvider requires a secret key');
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    form?: URLSearchParams,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': API_VERSION,
        },
        ...(form !== undefined ? { body: form.toString() } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : {};
      if (!res.ok) {
        const errBody = json as StripeErrorBody;
        throw new StripeApiError(
          errBody.error?.message ?? `Stripe request failed with status ${res.status}`,
          res.status,
          errBody.error?.code,
        );
      }
      return json as T;
    } catch (err) {
      if (err instanceof StripeApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new StripeApiError(`Stripe request to ${path} timed out`, 504);
      }
      throw new StripeApiError(err instanceof Error ? err.message : 'Stripe request failed', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  async createIntent(input: CreateGatewayIntentInput): Promise<GatewayIntentResult> {
    const amountMinorUnits = input.amount.mul(100).toDecimalPlaces(0).toNumber();
    const form = new URLSearchParams();
    form.set('amount', String(amountMinorUnits));
    form.set('currency', input.currency.toLowerCase());
    // Stripe's own idempotency-key mechanism is a request HEADER, not a body
    // field — sent separately so a retried createIntent call with the same
    // key returns the original PaymentIntent instead of creating a second one.
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      form.set(`metadata[${key}]`, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/payment_intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': API_VERSION,
          'Idempotency-Key': input.idempotencyKey,
        },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new StripeApiError('Stripe request to /payment_intents timed out', 504);
      }
      throw new StripeApiError(err instanceof Error ? err.message : 'Stripe request failed', 502);
    }
    clearTimeout(timeout);
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as StripePaymentIntentResponse & StripeErrorBody;
    if (!res.ok) {
      throw new StripeApiError(
        json.error?.message ?? `Stripe request failed with status ${res.status}`,
        res.status,
        json.error?.code,
      );
    }
    return {
      gatewayIntentId: json.id,
      ...(json.client_secret !== undefined ? { clientSecret: json.client_secret } : {}),
      status: mapIntentStatus(json.status),
    };
  }

  async confirmIntent(gatewayIntentId: string): Promise<GatewayIntentResult> {
    const intent = await this.request<StripePaymentIntentResponse>(
      'GET',
      `/payment_intents/${encodeURIComponent(gatewayIntentId)}`,
    );
    return { gatewayIntentId: intent.id, status: mapIntentStatus(intent.status) };
  }

  /// `providerPaymentId` is Stripe's own id — the charge (`ch_…`, what the
  /// webhook stores as `gatewayTxnId`) or the PaymentIntent (`pi_…`). This used
  /// to send our internal PaymentTransaction UUID as `payment_intent`, which
  /// Stripe rejects. `refundReference` (our Refund.id) is the Idempotency-Key,
  /// so a retry after a timeout returns the SAME refund, and it is stored in
  /// metadata so `findRefund` can recover it.
  async createRefund(input: CreateGatewayRefundInput): Promise<GatewayRefundResult> {
    const form = new URLSearchParams();
    form.set(stripePaymentField(input.providerPaymentId), input.providerPaymentId);
    form.set('amount', String(input.amount.mul(100).toDecimalPlaces(0).toNumber()));
    form.set('metadata[refund_reference]', input.refundReference);
    const json = await this.refundRequest<StripeRefund>('POST', '/refunds', form, {
      'Idempotency-Key': `refund-${input.refundReference}`,
    });
    return { gatewayRefundId: json.id, status: mapStripeRefundStatus(json.status) };
  }

  async findRefund(
    providerPaymentId: string,
    refundReference: string,
  ): Promise<GatewayRefundResult | null> {
    const query = new URLSearchParams();
    query.set(stripePaymentField(providerPaymentId), providerPaymentId);
    query.set('limit', '100');
    const json = await this.refundRequest<{ data: StripeRefund[] }>(
      'GET',
      `/refunds?${query.toString()}`,
    );
    const match = json.data.find((r) => r.metadata?.refund_reference === refundReference);
    return match
      ? { gatewayRefundId: match.id, status: mapStripeRefundStatus(match.status) }
      : null;
  }

  private async refundRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    form?: URLSearchParams,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Stripe-Version': API_VERSION,
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...extraHeaders,
        },
        ...(form ? { body: form.toString() } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & StripeErrorBody;
    if (!res.ok) {
      throw new StripeApiError(
        json.error?.message ?? `Stripe refund request failed with status ${res.status}`,
        res.status,
        json.error?.code,
      );
    }
    return json;
  }
}

interface StripeRefund {
  id: string;
  status: string;
  metadata?: Record<string, string> | null;
}

/// Stripe refunds a charge (`ch_…`) or a PaymentIntent (`pi_…`) by different
/// parameter names; the stored provider payment id says which one it is.
function stripePaymentField(providerPaymentId: string): 'charge' | 'payment_intent' {
  return providerPaymentId.startsWith('ch_') ? 'charge' : 'payment_intent';
}

function mapStripeRefundStatus(status: string): 'SUCCEEDED' | 'PENDING' | 'FAILED' {
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed' || status === 'canceled') return 'FAILED';
  return 'PENDING';
}

function mapIntentStatus(status: string): string {
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'canceled' || status === 'requires_payment_method') return 'FAILED';
  return 'PENDING';
}

/// Stripe's REAL webhook signature scheme — deliberately NOT the generic
/// HMAC-over-raw-body verifier every other gateway in this codebase used
/// before this change. The `Stripe-Signature` header carries
/// `t=<unix_seconds>,v1=<hex_hmac>[,v1=<hex_hmac>...]` — Stripe sends
/// multiple `v1` values during secret rotation, and ANY matching one is
/// valid. The signed payload is `${timestamp}.${rawBody}`, never the raw
/// body alone (spec section 8's explicit requirement).
export function verifyStripeWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader || !webhookSecret) return false;
  const parts = signatureHeader.split(',').map((p) => p.trim());
  let timestamp: string | null = null;
  const v1Signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value) timestamp = value;
    if (key === 'v1' && value) v1Signatures.push(value);
  }
  if (!timestamp || v1Signatures.length === 0) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf-8');

  return v1Signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf-8');
    if (sigBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(sigBuf, expectedBuf);
  });
}
