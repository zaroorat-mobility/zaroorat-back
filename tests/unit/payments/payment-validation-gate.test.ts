import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/// 005-razorpay-driver-payments T012 (TM-02; CD-4, CD-6). The payment
/// application rules A1–A12 of spec.md, as one pure decision. Written before
/// T024 as `todo` cases; T024 (`decidePaymentApplication` in
/// `src/modules/payments/services/intent/payment-application-rules.ts`) made
/// them pass.

type ProviderStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
interface GateInput {
  path: 'VERIFY' | 'WEBHOOK' | 'RECONCILIATION' | 'SWEEP' | 'STAFF_CONFIRM';
  /// null: the order is not one we created (A9).
  intent: {
    status: string;
    orderId: string;
    amountPaise: number;
    currency: string;
    /// The `pay_…` id of this intent's SUCCEEDED payment row, if any.
    succeededPaymentId: string | null;
  } | null;
  provider:
    | { kind: 'unknown' }
    | {
        kind: 'payment';
        payment: {
          id: string;
          orderId: string;
          amountPaise: number;
          currency: string;
          status: ProviderStatus;
        };
      };
  /// True when this `pay_…` id is already SUCCEEDED on a different intent.
  paymentAppliedElsewhere: boolean;
  /// For `refunded`: whether a Zaroorat refund explains it.
  refundRecorded?: boolean;
  /// Driver `verify` path only.
  verify?: { callerOwnsIntent: boolean; signatureValid: boolean; callbackOrderId: string };
}
interface GateDecision {
  rule:
    | 'UNKNOWN'
    | 'A1'
    | 'A2'
    | 'A3'
    | 'A4'
    | 'A5'
    | 'A6'
    | 'A7'
    | 'A8'
    | 'A9'
    | 'A10'
    | 'A11'
    | 'A12';
  outcome: 'REJECT' | 'NO_CHANGE' | 'MARK_FAILED' | 'APPLY' | 'REVIEW' | 'NO_OP';
  reviewKind?: string;
  /// The intent status after the decision; absent when it does not change.
  intentStatusAfter?: string;
  /// A4 on an EXPIRED intent.
  alert?: boolean;
}

// Typed `string` so the compiler does not try to resolve a module T024 has not
// written yet; the relative path is resolved against this file at runtime.
const GATE_MODULE: string =
  '../../../src/modules/payments/services/intent/payment-application-rules.js';

async function decide(input: GateInput): Promise<GateDecision> {
  const mod = (await import(GATE_MODULE)) as {
    decidePaymentApplication: (i: GateInput) => GateDecision;
  };
  return mod.decidePaymentApplication(input);
}

const intent = (over: Partial<NonNullable<GateInput['intent']>> = {}) => ({
  status: 'PENDING',
  orderId: 'order_1',
  amountPaise: 50000,
  currency: 'INR',
  succeededPaymentId: null,
  ...over,
});
const payment = (
  over: Partial<{
    id: string;
    orderId: string;
    amountPaise: number;
    currency: string;
    status: ProviderStatus;
  }> = {},
) => ({
  kind: 'payment' as const,
  payment: {
    id: 'pay_1',
    orderId: 'order_1',
    amountPaise: 50000,
    currency: 'INR',
    status: 'captured' as ProviderStatus,
    ...over,
  },
});
const input = (over: Partial<GateInput> = {}): GateInput => ({
  path: 'WEBHOOK',
  intent: intent(),
  provider: payment(),
  paymentAppliedElsewhere: false,
  ...over,
});

describe('payment application rules (T012)', () => {
  describe('A1 — driver verify path', () => {
    for (const [label, verify] of [
      [
        'a caller who does not own the intent',
        { callerOwnsIntent: false, signatureValid: true, callbackOrderId: 'order_1' },
      ],
      [
        'an invalid checkout signature',
        { callerOwnsIntent: true, signatureValid: false, callbackOrderId: 'order_1' },
      ],
      [
        'a callback for another order',
        { callerOwnsIntent: true, signatureValid: true, callbackOrderId: 'order_X' },
      ],
    ] as const) {
      it(`rejects ${label} with no state change`, async () => {
        const d = await decide(input({ path: 'VERIFY', verify }));
        assert.equal(d.rule, 'A1');
        assert.equal(d.outcome, 'REJECT');
        assert.equal(d.intentStatusAfter, undefined);
      });
    }
  });

  it('treats an unreachable provider as unknown: no change, never FAILED (INV-8)', async () => {
    const d = await decide(input({ provider: { kind: 'unknown' } }));
    assert.equal(d.rule, 'UNKNOWN');
    assert.equal(d.outcome, 'NO_CHANGE');
    assert.equal(d.intentStatusAfter, undefined);
  });

  it('A9 — a capture for an order we did not create goes to review', async () => {
    const d = await decide(input({ intent: null }));
    assert.deepEqual([d.rule, d.outcome, d.reviewKind], ['A9', 'REVIEW', 'UNKNOWN_ORDER']);
  });

  for (const status of ['created', 'authorized'] as const) {
    it(`A2 — ${status} never credits`, async () => {
      const d = await decide(input({ provider: payment({ status }) }));
      assert.deepEqual([d.rule, d.outcome], ['A2', 'NO_CHANGE']);
    });
  }

  it('A3 — a failed payment marks a PENDING intent FAILED', async () => {
    const d = await decide(input({ provider: payment({ status: 'failed' }) }));
    assert.deepEqual([d.rule, d.outcome, d.intentStatusAfter], ['A3', 'MARK_FAILED', 'FAILED']);
  });

  it('A12 — a failure after success is a no-op, never a reversal (CD-5)', async () => {
    const d = await decide(
      input({
        intent: intent({ status: 'SUCCEEDED', succeededPaymentId: 'pay_1' }),
        provider: payment({ status: 'failed', id: 'pay_2' }),
      }),
    );
    assert.deepEqual([d.rule, d.outcome], ['A12', 'NO_OP']);
    assert.equal(d.intentStatusAfter, undefined);
  });

  it('A10 — a refund we did not make goes to review', async () => {
    const d = await decide(
      input({
        intent: intent({ status: 'SUCCEEDED', succeededPaymentId: 'pay_1' }),
        provider: payment({ status: 'refunded' }),
        refundRecorded: false,
      }),
    );
    assert.deepEqual([d.rule, d.outcome, d.reviewKind], ['A10', 'REVIEW', 'EXTERNAL_REFUND']);
  });

  describe('A5 — order, then amount, then currency', () => {
    // Decision R1 (decisions.md §2b, 2026-10-21) replaced "order mismatch →
    // review + MANUAL_REVIEW": another order's payment is rejected with no
    // change to this intent, and the order check still wins over the amount.
    for (const [label, over] of [
      ['another order', { orderId: 'order_X' }],
      ['another order and amount (order wins)', { orderId: 'order_X', amountPaise: 1 }],
    ] as const) {
      it(`rejects a capture for ${label}: no review, no status change, no money`, async () => {
        const d = await decide(input({ provider: payment(over) }));
        assert.deepEqual([d.rule, d.outcome], ['A5', 'REJECT']);
        assert.equal(d.reviewKind, undefined);
        assert.equal(d.intentStatusAfter, undefined);
      });
    }

    for (const [label, over, kind] of [
      ['one paisa short', { amountPaise: 49999 }, 'AMOUNT_MISMATCH'],
      ['one paisa over', { amountPaise: 50001 }, 'AMOUNT_MISMATCH'],
      ['another currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ] as const) {
      it(`sends a capture with ${label} to review and moves no money`, async () => {
        const d = await decide(input({ provider: payment(over) }));
        assert.deepEqual([d.rule, d.outcome, d.reviewKind], ['A5', 'REVIEW', kind]);
        assert.equal(d.intentStatusAfter, 'MANUAL_REVIEW');
      });
    }
  });

  it('A11 — the same payment already applied to this intent is a no-op', async () => {
    const d = await decide(
      input({ intent: intent({ status: 'SUCCEEDED', succeededPaymentId: 'pay_1' }) }),
    );
    assert.deepEqual([d.rule, d.outcome], ['A11', 'NO_OP']);
  });

  it('A6 — a payment applied to another intent goes to review', async () => {
    const d = await decide(input({ paymentAppliedElsewhere: true }));
    assert.deepEqual([d.rule, d.outcome, d.reviewKind], ['A6', 'REVIEW', 'PAYMENT_ID_REUSED']);
  });

  it('A6 leaves an already SUCCEEDED intent SUCCEEDED', async () => {
    const d = await decide(
      input({
        intent: intent({ status: 'SUCCEEDED', succeededPaymentId: 'pay_0' }),
        paymentAppliedElsewhere: true,
      }),
    );
    assert.equal(d.rule, 'A6');
    assert.equal(d.intentStatusAfter, undefined);
  });

  it('A7 — a second capture on a SUCCEEDED intent goes to review and the intent stays SUCCEEDED (CD-6)', async () => {
    const d = await decide(
      input({
        intent: intent({ status: 'SUCCEEDED', succeededPaymentId: 'pay_0' }),
        provider: payment({ id: 'pay_1' }),
      }),
    );
    assert.deepEqual([d.rule, d.outcome, d.reviewKind], ['A7', 'REVIEW', 'MULTIPLE_CAPTURES']);
    assert.equal(d.intentStatusAfter, undefined);
  });

  it('A8 — a capture on a CANCELLED (superseded) intent goes to review', async () => {
    const d = await decide(input({ intent: intent({ status: 'CANCELLED' }) }));
    assert.deepEqual([d.rule, d.outcome, d.reviewKind], ['A8', 'REVIEW', 'UNMATCHED_CAPTURE']);
  });

  describe('A4 — apply exactly once from the allowed statuses (data-model §2)', () => {
    for (const status of ['PENDING', 'PROCESSING', 'FAILED', 'EXPIRED']) {
      it(`applies a matching capture to a ${status} intent`, async () => {
        const d = await decide(input({ intent: intent({ status }) }));
        assert.deepEqual([d.rule, d.outcome, d.intentStatusAfter], ['A4', 'APPLY', 'SUCCEEDED']);
        assert.equal(Boolean(d.alert), status === 'EXPIRED');
      });
    }

    it('never moves a MANUAL_REVIEW intent to SUCCEEDED: only Finance CREDIT does', async () => {
      const d = await decide(input({ intent: intent({ status: 'MANUAL_REVIEW' }) }));
      assert.notEqual(d.outcome, 'APPLY');
    });
  });
});
