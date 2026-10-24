import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRazorpayWebhook,
  parseStripeWebhook,
} from '../../../src/modules/payments/utils/webhook-payload-parser.js';
import { decidePaymentApplication } from '../../../src/modules/payments/services/intent/payment-application-rules.js';

/// 005-razorpay-driver-payments T024 (the part of T031's parser the gate
/// needs): the payment fields a signed webhook hands the validation gate.
/// Missing or malformed fields give no payment at all, so nothing is applied;
/// a well-formed but wrong amount reaches the gate and goes to review.

const entity = (over: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  order_id: 'order_1',
  amount: 50000,
  currency: 'INR',
  status: 'captured',
  ...over,
});
const razorpay = (event: string, payment: Record<string, unknown>, order?: unknown) =>
  parseRazorpayWebhook(
    {
      event,
      created_at: 1_760_000_000,
      payload: { payment: { entity: payment }, ...(order ? { order: { entity: order } } : {}) },
    },
    'evt_1',
  );
const intent = {
  status: 'PENDING',
  orderId: 'order_1',
  amountPaise: 50000,
  currency: 'INR',
  succeededPaymentId: null,
};

describe('webhook payment fields for the validation gate (T024)', () => {
  it('reads id, order, amount, currency and status from payment.captured', () => {
    assert.deepEqual(razorpay('payment.captured', entity()).payment, {
      id: 'pay_1',
      orderId: 'order_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
  });

  for (const [label, over] of [
    ['missing amount', { amount: undefined }],
    ['missing currency', { currency: undefined }],
    ['missing status', { status: undefined }],
    ['missing order id', { order_id: undefined }],
    ['amount as a string', { amount: '50000' }],
    ['fractional amount', { amount: 500.5 }],
    ['negative amount', { amount: -1 }],
    ['currency not ISO-4217 shaped', { currency: 'RUPEES' }],
    ['undocumented status', { status: 'settled' }],
  ] as const) {
    it(`gives no payment for ${label}, so the gate changes nothing`, () => {
      const parsed = razorpay('payment.captured', entity(over));
      assert.equal(parsed.payment, null);
      const d = decidePaymentApplication({
        path: 'WEBHOOK',
        intent,
        provider: { kind: 'unknown' },
        paymentAppliedElsewhere: false,
      });
      assert.deepEqual([d.rule, d.outcome], ['UNKNOWN', 'NO_CHANGE']);
    });
  }

  it('lets a mismatched amount through to the gate, which holds it', () => {
    const parsed = razorpay('payment.captured', entity({ amount: 49999 }));
    assert.ok(parsed.payment);
    const d = decidePaymentApplication({
      path: 'WEBHOOK',
      intent,
      provider: { kind: 'payment', payment: parsed.payment },
      paymentAppliedElsewhere: false,
    });
    assert.deepEqual([d.rule, d.reviewKind], ['A5', 'AMOUNT_MISMATCH']);
  });

  it('lets a mismatched currency through to the gate, which holds it', () => {
    const parsed = razorpay('payment.captured', entity({ currency: 'usd' }));
    assert.equal(parsed.payment?.currency, 'USD');
    const d = decidePaymentApplication({
      path: 'WEBHOOK',
      intent,
      provider: { kind: 'payment', payment: parsed.payment! },
      paymentAppliedElsewhere: false,
    });
    assert.deepEqual([d.rule, d.reviewKind], ['A5', 'CURRENCY_MISMATCH']);
  });

  describe('order.paid', () => {
    it('carries amount_paid, and a differing one is an AMOUNT_MISMATCH', () => {
      const parsed = razorpay('order.paid', entity(), { amount: 50000, amount_paid: 49999 });
      assert.equal(parsed.orderAmountPaidPaise, 49999);
      const d = decidePaymentApplication({
        path: 'WEBHOOK',
        intent,
        provider: {
          kind: 'payment',
          payment: parsed.payment!,
          orderAmountPaidPaise: parsed.orderAmountPaidPaise!,
        },
        paymentAppliedElsewhere: false,
      });
      assert.deepEqual([d.rule, d.reviewKind], ['A5', 'AMOUNT_MISMATCH']);
    });

    for (const [label, order] of [
      ['no order entity', undefined],
      ['no amount_paid', { amount: 50000 }],
      ['a malformed amount_paid', { amount_paid: '50000' }],
    ] as const) {
      it(`gives no payment with ${label}`, () => {
        assert.equal(razorpay('order.paid', entity(), order).payment, null);
      });
    }
  });

  it('reads an auto-refunded authorisation as failed, not as an external refund', () => {
    const parsed = razorpay('payment.failed', entity({ status: 'refunded', captured: false }));
    assert.equal(parsed.payment?.status, 'failed');
  });

  it('reads a Stripe PaymentIntent with amount_received and an upper-cased currency', () => {
    const parsed = parseStripeWebhook({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_1',
          latest_charge: 'ch_1',
          amount: 50000,
          amount_received: 50000,
          currency: 'inr',
        },
      },
    });
    assert.deepEqual(parsed.payment, {
      id: 'ch_1',
      orderId: 'pi_1',
      amountPaise: 50000,
      currency: 'INR',
      status: 'captured',
    });
  });

  describe('gate cases added with T024', () => {
    const captured = {
      kind: 'payment' as const,
      payment: { id: 'pay_1', orderId: 'order_1', amountPaise: 50000, currency: 'INR' },
    };
    const decide = (over: Partial<Parameters<typeof decidePaymentApplication>[0]>) =>
      decidePaymentApplication({
        path: 'WEBHOOK',
        intent,
        provider: { ...captured, payment: { ...captured.payment, status: 'captured' } },
        paymentAppliedElsewhere: false,
        ...over,
      });

    it('treats a payment already held on this intent as a duplicate (no second case)', () => {
      const d = decide({
        intent: { ...intent, status: 'MANUAL_REVIEW' },
        paymentHeldOnIntent: true,
      });
      assert.deepEqual([d.rule, d.outcome], ['A11', 'NO_OP']);
    });

    it('holds a further capture on an intent already in review, leaving it there', () => {
      const d = decide({ intent: { ...intent, status: 'MANUAL_REVIEW' } });
      assert.deepEqual([d.outcome, d.reviewKind], ['REVIEW', 'MULTIPLE_CAPTURES']);
      assert.equal(d.intentStatusAfter, undefined);
    });

    it('opens nothing for a non-captured payment on an order we did not create', () => {
      const d = decide({
        intent: null,
        provider: { ...captured, payment: { ...captured.payment, status: 'failed' } },
      });
      assert.deepEqual([d.rule, d.outcome], ['A9', 'NO_OP']);
    });

    it('is a no-op for a refund our records explain', () => {
      const d = decide({
        intent: { ...intent, status: 'SUCCEEDED', succeededPaymentId: 'pay_1' },
        provider: { ...captured, payment: { ...captured.payment, status: 'refunded' } },
        refundRecorded: true,
      });
      assert.deepEqual([d.rule, d.outcome], ['A10', 'NO_OP']);
    });

    it('never marks an EXPIRED or MANUAL_REVIEW intent FAILED', () => {
      for (const status of ['EXPIRED', 'MANUAL_REVIEW', 'CANCELLED']) {
        const d = decide({
          intent: { ...intent, status },
          provider: { ...captured, payment: { ...captured.payment, status: 'failed' } },
        });
        assert.equal(d.outcome, 'NO_CHANGE', status);
      }
    });
  });

  it('gives no Stripe payment when the amount is missing', () => {
    const parsed = parseStripeWebhook({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', currency: 'inr' } },
    });
    assert.equal(parsed.payment, null);
  });
});
