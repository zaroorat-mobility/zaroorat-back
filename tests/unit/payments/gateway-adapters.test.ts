import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  RazorpayGatewayProvider,
  RazorpayApiError,
} from '../../../src/integrations/razorpay/razorpay.client.js';
import {
  StripeGatewayProvider,
  StripeApiError,
} from '../../../src/integrations/stripe/stripe.client.js';
import { Decimal } from '../../../src/modules/payments/types/index.js';

type FetchCall = { url: string; init: RequestInit | undefined };

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  (calls as unknown as { restore: () => void }).restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Gateway adapters — real order/intent creation against the actual API shapes', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  describe('Razorpay', () => {
    it('creates a real order against the Razorpay Orders API with Basic auth', async () => {
      const calls = stubFetch(() => jsonResponse(200, { id: 'order_rzp1', status: 'created' }));
      restore = () => (calls as unknown as { restore: () => void }).restore();

      const provider = new RazorpayGatewayProvider('key_id_1', 'key_secret_1', 'sandbox');
      const result = await provider.createIntent({
        amount: new Decimal(250),
        currency: 'INR',
        idempotencyKey: 'idem-rzp',
      });

      assert.equal(result.gatewayIntentId, 'order_rzp1');
      assert.equal(result.status, 'PENDING');

      const headers = calls[0]!.init?.headers as Record<string, string>;
      const expectedAuth = `Basic ${Buffer.from('key_id_1:key_secret_1').toString('base64')}`;
      assert.equal(headers.Authorization, expectedAuth);
      const body = JSON.parse(String(calls[0]!.init?.body));
      // Rupees -> paise.
      assert.equal(body.amount, 25000);
      assert.equal(body.receipt, 'idem-rzp');
    });

    it('resolves the authoritative payment from a list of attempts on confirmIntent', async () => {
      const calls = stubFetch(() =>
        jsonResponse(200, {
          items: [
            { id: 'pay_1', order_id: 'order_1', status: 'failed' },
            { id: 'pay_2', order_id: 'order_1', status: 'captured' },
          ],
        }),
      );
      restore = () => (calls as unknown as { restore: () => void }).restore();

      const provider = new RazorpayGatewayProvider('id', 'secret', 'sandbox');
      const result = await provider.confirmIntent('order_1');
      assert.equal(result.status, 'SUCCEEDED');
      assert.match(calls[0]!.url, /\/payments\?order_id=order_1$/);
    });

    it('surfaces a Razorpay API error with the gateway error code', async () => {
      const calls = stubFetch(() =>
        jsonResponse(400, {
          error: { description: 'amount must be positive', code: 'BAD_REQUEST_ERROR' },
        }),
      );
      restore = () => (calls as unknown as { restore: () => void }).restore();

      const provider = new RazorpayGatewayProvider('id', 'secret', 'sandbox');
      await assert.rejects(
        () =>
          provider.createIntent({ amount: new Decimal(10), currency: 'INR', idempotencyKey: 'k' }),
        (err: unknown) => {
          assert.ok(err instanceof RazorpayApiError);
          assert.equal(err.statusCode, 400);
          assert.equal(err.gatewayCode, 'BAD_REQUEST_ERROR');
          return true;
        },
      );
    });
  });

  describe('Stripe', () => {
    it('creates a real PaymentIntent with Bearer auth and form-encoded body', async () => {
      const calls = stubFetch(() =>
        jsonResponse(200, {
          id: 'pi_stripe_1',
          status: 'requires_payment_method',
          client_secret: 'pi_secret_1',
        }),
      );
      restore = () => (calls as unknown as { restore: () => void }).restore();

      const provider = new StripeGatewayProvider('sk_test_1');
      const result = await provider.createIntent({
        amount: new Decimal(19.99),
        currency: 'usd',
        idempotencyKey: 'idem-stripe',
        metadata: { userId: 'u1' },
      });

      assert.equal(result.gatewayIntentId, 'pi_stripe_1');
      assert.equal(result.clientSecret, 'pi_secret_1');
      // mapIntentStatus treats requires_payment_method as FAILED — this
      // codebase has no "retry with a different card on the same intent" UX,
      // so a Stripe PaymentIntent asking for a (new) payment method is
      // treated the same as a decline. (This is genuinely ambiguous right at
      // creation, before the customer has attempted anything — but
      // PaymentIntent.status in this codebase is set from the DB default,
      // never from this field, so the distinction has no live consequence.)
      assert.equal(result.status, 'FAILED');

      const headers = calls[0]!.init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, 'Bearer sk_test_1');
      assert.equal(headers['Idempotency-Key'], 'idem-stripe');
      assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(String(calls[0]!.init?.body));
      // Dollars -> cents.
      assert.equal(form.get('amount'), '1999');
      assert.equal(form.get('currency'), 'usd');
      assert.equal(form.get('metadata[userId]'), 'u1');
    });

    it('maps succeeded/canceled PaymentIntent statuses correctly on lookup', async () => {
      const succeeded = stubFetch(() => jsonResponse(200, { id: 'pi_1', status: 'succeeded' }));
      const provider = new StripeGatewayProvider('sk_test_1');
      const result = await provider.confirmIntent('pi_1');
      assert.equal(result.status, 'SUCCEEDED');
      (succeeded as unknown as { restore: () => void }).restore();
    });

    it('surfaces a Stripe API error rather than swallowing it', async () => {
      const calls = stubFetch(() =>
        jsonResponse(402, { error: { message: 'Your card was declined.', code: 'card_declined' } }),
      );
      restore = () => (calls as unknown as { restore: () => void }).restore();

      const provider = new StripeGatewayProvider('sk_test_1');
      await assert.rejects(
        () =>
          provider.createIntent({ amount: new Decimal(10), currency: 'usd', idempotencyKey: 'k' }),
        (err: unknown) => {
          assert.ok(err instanceof StripeApiError);
          assert.equal(err.statusCode, 402);
          assert.equal(err.gatewayCode, 'card_declined');
          return true;
        },
      );
    });

    it('requires a secret key', () => {
      assert.throws(() => new StripeGatewayProvider(''));
    });
  });
});
