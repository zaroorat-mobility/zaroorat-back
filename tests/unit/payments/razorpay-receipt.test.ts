import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import * as razorpay from '../../../src/integrations/razorpay/razorpay.client.js';
import { Decimal } from '../../../src/modules/payments/types/index.js';

/// 005-razorpay-driver-payments T013 (TM-03, CD-2). Written before T016 as
/// `todo` cases; T016 made the receipt cases pass. The receipt-lookup recovery
/// cases stay `todo`: sandbox S2c/S2d withdrew that recovery and its
/// replacement awaits the Owner (decisions.md TD-3).

const TD3_PENDING = 'TD-3 recovery withdrawn by sandbox S2c/S2d; replacement pending Owner review';
const receipt = razorpay.razorpayReceipt;

const SUBSCRIPTION_KEY =
  'subscription:0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0a11:0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0a22';
const RECHARGE_KEY =
  'recharge:0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0a11:0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0a22';

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function stub(handler: (call: Call) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const res = handler(call);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

const createOrder = (key = RECHARGE_KEY, amount = 500) =>
  new razorpay.RazorpayGatewayProvider('rzp_test_key', 'secret').createIntent({
    amount: new Decimal(amount),
    currency: 'INR',
    idempotencyKey: key,
  });

const DUPLICATE = {
  status: 400,
  body: {
    error: {
      code: 'BAD_REQUEST_ERROR',
      description: 'Duplicate request. This request has already been processed.',
    },
  },
};

describe('Razorpay order receipt (T013)', () => {
  it('is zr1_ plus 32 hex characters, 36 in all, for subscription and recharge keys', () => {
    for (const key of [SUBSCRIPTION_KEY, RECHARGE_KEY]) {
      const value = receipt(key);
      assert.match(value, /^zr1_[0-9a-f]{32}$/);
      assert.ok(value.length <= 40);
    }
  });

  it('is the same for the same key and different for 100,000 different keys', () => {
    assert.equal(receipt(RECHARGE_KEY), receipt(RECHARGE_KEY));
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) seen.add(receipt(`recharge:driver:${i}`));
    assert.equal(seen.size, 100_000);
  });

  it('is what createIntent sends, with partial_payment: false', async () => {
    const calls = stub(() => ({ status: 200, body: { id: 'order_1', status: 'created' } }));
    await createOrder();

    assert.equal(calls[0]!.body?.receipt, receipt(RECHARGE_KEY));
    assert.equal(calls[0]!.body?.partial_payment, false);
  });

  it(
    'recovers the original order by receipt after any 400 when amount and currency match',
    { todo: TD3_PENDING },
    async () => {
      const calls = stub((call) =>
        call.method === 'POST'
          ? DUPLICATE
          : {
              status: 200,
              body: {
                items: [{ id: 'order_first', amount: 50000, currency: 'INR', status: 'created' }],
              },
            },
      );
      const result = await createOrder();

      assert.equal(result.gatewayIntentId, 'order_first');
      assert.match(calls[1]!.url, /\/orders\?receipt=zr1_[0-9a-f]{32}$/);
    },
  );

  it('treats a 400 from POST /orders as a gateway error and looks nothing up', async () => {
    const calls = stub(() => DUPLICATE);
    await assert.rejects(createOrder(), (err: unknown) => {
      assert.equal((err as { statusCode?: number }).statusCode, 400);
      return true;
    });
    assert.equal(calls.length, 1, 'no receipt lookup (contract §1)');
  });

  for (const [label, items] of [
    ['no order', []],
    [
      'two orders',
      [
        { id: 'order_a', amount: 50000, currency: 'INR', status: 'created' },
        { id: 'order_b', amount: 50000, currency: 'INR', status: 'created' },
      ],
    ],
    [
      'an order for another amount',
      [{ id: 'order_a', amount: 49999, currency: 'INR', status: 'created' }],
    ],
  ] as const) {
    it(
      `fails with PAYMENT_GATEWAY_UNAVAILABLE when the lookup finds ${label}`,
      { todo: TD3_PENDING },
      async () => {
        stub((call) => (call.method === 'POST' ? DUPLICATE : { status: 200, body: { items } }));
        await assert.rejects(createOrder(), (err: unknown) => {
          assert.equal((err as { code?: string }).code, 'PAYMENT_GATEWAY_UNAVAILABLE');
          return true;
        });
      },
    );
  }
});
