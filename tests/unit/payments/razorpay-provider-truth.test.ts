import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { RazorpayGatewayProvider } from '../../../src/integrations/razorpay/razorpay.client.js';

/// 005-razorpay-driver-payments T010 (TM-01, CD-1). Written before T015/T016
/// as `todo` cases; T016 made them pass.

interface NormalisedPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  status: string;
}
interface OrderPayments {
  kind: 'captured' | 'pending' | 'failed' | 'none';
  payment?: NormalisedPayment;
  /// Captured payments beyond the first: each one is a MULTIPLE_CAPTURES case.
  additionalCaptures: NormalisedPayment[];
}
type PlannedProvider = { fetchOrderPayments(orderId: string): Promise<OrderPayments> };

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function stubPayments(items: Record<string, unknown>[]): string[] {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ entity: 'collection', count: items.length, items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return urls;
}

const provider = () =>
  new RazorpayGatewayProvider('rzp_test_key', 'secret') as unknown as PlannedProvider;
const item = (id: string, status: string, orderId = 'order_1', amount = 50000) => ({
  id,
  entity: 'payment',
  order_id: orderId,
  amount,
  currency: 'INR',
  status,
});

describe('Razorpay provider truth — GET /orders/{id}/payments (T010)', () => {
  it('asks the documented endpoint for our order, never /payments?order_id=', async () => {
    const urls = stubPayments([item('pay_1', 'captured')]);
    await provider().fetchOrderPayments('order_1');

    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /\/orders\/order_1\/payments$/);
    assert.ok(!urls[0]!.includes('order_id='));
  });

  it('returns the captured payment with its pay_ id and amount in paise', async () => {
    stubPayments([item('pay_1', 'failed'), item('pay_2', 'captured')]);
    const result = await provider().fetchOrderPayments('order_1');

    assert.equal(result.kind, 'captured');
    assert.equal(result.payment?.id, 'pay_2');
    assert.equal(result.payment?.orderId, 'order_1');
    assert.equal(result.payment?.amountPaise, 50000);
  });

  it('ignores an item that belongs to another order, even a captured one', async () => {
    stubPayments([item('pay_other', 'captured', 'order_OTHER')]);
    const result = await provider().fetchOrderPayments('order_1');

    assert.equal(result.kind, 'none');
    assert.equal(result.payment, undefined);
  });

  it('reports an authorized-only order as pending, never as captured', async () => {
    stubPayments([item('pay_1', 'authorized')]);
    assert.equal((await provider().fetchOrderPayments('order_1')).kind, 'pending');
  });

  it('reports a failed-only order as failed', async () => {
    stubPayments([item('pay_1', 'failed')]);
    assert.equal((await provider().fetchOrderPayments('order_1')).kind, 'failed');
  });

  it('reports an order with no payments as none', async () => {
    stubPayments([]);
    assert.equal((await provider().fetchOrderPayments('order_1')).kind, 'none');
  });

  it('returns the first capture and lists every further capture for review', async () => {
    stubPayments([item('pay_1', 'captured'), item('pay_2', 'captured')]);
    const result = await provider().fetchOrderPayments('order_1');

    assert.equal(result.payment?.id, 'pay_1');
    assert.deepEqual(
      result.additionalCaptures.map((p) => p.id),
      ['pay_2'],
    );
  });
});
