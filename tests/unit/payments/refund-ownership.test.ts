import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decimal } from '../../../src/modules/payments/types/index.js';
import {
  RefundService,
  type RefundStaffScope,
} from '../../../src/modules/payments/services/refund/refund.service.js';
import { RefundNotAllowedError } from '../../../src/modules/payments/errors/payment.errors.js';
import type { CreateGatewayRefundInput } from '../../../src/modules/payments/services/gateway/gateway.provider.js';

/// Unit harness for `RefundService` authorization and bounds. Everything the
/// service touches is faked in memory; the integration suite
/// (`refund-lifecycle.test.ts`) covers the same rules against the database.
function harness(
  transaction: {
    userId: string;
    amount: number;
    purpose?: string;
    gateway?: string;
    gatewayTxnId?: string | null;
    rideId?: string | null;
    status?: string;
  } | null,
  providerBehaviour: 'SUCCEED' | 'TIMEOUT' | 'REJECT' | 'APPLY_FAILS_ONCE' = 'SUCCEED',
) {
  const created: { userId: string; amount: Decimal }[] = [];
  const providerCalls: CreateGatewayRefundInput[] = [];
  const debits: { userId: string; amount: Decimal }[] = [];
  let refund: Record<string, unknown> | null = null;
  let applyFailuresLeft = providerBehaviour === 'APPLY_FAILS_ONCE' ? 1 : 0;

  const txn = transaction
    ? {
        id: 'txn_1',
        userId: transaction.userId,
        amount: new Decimal(transaction.amount),
        status: transaction.status ?? 'SUCCEEDED',
        txnType: 'PAYMENT',
        gateway: transaction.gateway ?? 'mock',
        gatewayTxnId:
          transaction.gatewayTxnId === undefined ? 'pay_provider1' : transaction.gatewayTxnId,
        rideId: transaction.rideId ?? null,
        intentId: 'intent_1',
        purpose: transaction.purpose ?? 'CUSTOMER_WALLET_TOPUP',
      }
    : null;

  const refundRepo = {
    async findByIdempotencyKey() {
      return null;
    },
    async lockTransaction() {
      return txn;
    },
    async findRefundableTransaction() {
      return txn;
    },
    async getCommittedForTransaction() {
      return new Decimal(0);
    },
    async create(data: { userId: string; amount: Decimal }) {
      created.push(data);
      refund = { id: 'rf_1', ...data, status: 'PENDING', transactionId: 'txn_1' };
      return refund;
    },
    async markProcessing(_id: string, data: Record<string, unknown>) {
      refund = { ...(refund as object), ...data, status: 'PROCESSING' };
      return refund;
    },
    async claimDispatch() {
      return true;
    },
    async findById() {
      return refund;
    },
    async lockForUpdate() {
      if (applyFailuresLeft > 0) {
        applyFailuresLeft--;
        throw new Error('database unavailable');
      }
      return refund;
    },
    async recordDispatchError(_id: string, message: string) {
      refund = { ...(refund as object), lastDispatchError: message };
      return refund;
    },
    async setGatewayRefundId(_id: string, gatewayRefundId: string) {
      refund = { ...(refund as object), gatewayRefundId };
      return refund;
    },
    async markSucceeded(_id: string, gatewayRefundId: string) {
      refund = { ...(refund as object), gatewayRefundId, status: 'SUCCEEDED' };
      return refund;
    },
    async markFailed(_id: string, failureReason: string) {
      refund = { ...(refund as object), failureReason, status: 'FAILED' };
      return refund;
    },
  };

  const provider = {
    gatewayName: 'mock',
    async findRefund() {
      return null;
    },
    async createRefund(input: CreateGatewayRefundInput) {
      providerCalls.push(input);
      if (providerBehaviour === 'TIMEOUT')
        throw Object.assign(new Error('timeout'), { statusCode: 504 });
      if (providerBehaviour === 'REJECT')
        throw Object.assign(new Error('bad request'), { statusCode: 400 });
      return { gatewayRefundId: 'grf_1', status: 'SUCCEEDED' as const };
    },
  };

  const service = new RefundService(
    refundRepo as never,
    {
      async forProviderName() {
        return provider;
      },
    } as never,
    {
      async postTransactionGroup() {
        return [];
      },
    } as never,
    {
      async execute<T>(fn: (tx: unknown) => Promise<T>) {
        return fn({});
      },
    } as never,
    { async publish() {} } as never,
    { refundFailure() {}, refundProcessed() {} } as never,
    {
      async debitInTx(userId: string, amount: Decimal) {
        debits.push({ userId, amount });
      },
      async creditInTx() {},
    } as never,
    { async debitForRefundInTx() {}, async restoreRefundedCreditInTx() {} } as never,
    {
      async findByUserId() {
        return { id: 'driver_1' };
      },
    } as never,
  );

  const refundAs = (userId: string, amount: number, staffScope: RefundStaffScope = 'NONE') =>
    service.processRefund({
      transactionId: 'txn_1',
      userId,
      amount: new Decimal(amount),
      idempotencyKey: 'key_1',
      staffScope,
    });

  return { service, created, providerCalls, debits, refundAs, current: () => refund };
}

describe('Refund authorization', () => {
  it('refunds the caller’s own wallet top-up', async () => {
    const h = harness({ userId: 'user-1', amount: 500 });
    const result = await h.refundAs('user-1', 100);
    assert.equal(h.created.length, 1);
    assert.equal(result.status, 'SUCCEEDED');
  });

  it('refuses to refund another user’s transaction', async () => {
    const h = harness({ userId: 'victim', amount: 500 });
    await assert.rejects(
      h.refundAs('attacker', 100),
      (err: unknown) => err instanceof RefundNotAllowedError,
    );
    assert.deepEqual(h.created, []);
  });

  it('gives the same answer for a foreign and a missing transaction', async () => {
    const messages: string[] = [];
    for (const h of [harness({ userId: 'victim', amount: 500 }), harness(null)]) {
      await h.refundAs('attacker', 100).catch((err: Error) => messages.push(err.message));
    }
    assert.equal(messages.length, 2);
    assert.equal(messages[0], messages[1]);
  });

  it('lets support refund a customer’s top-up on their behalf', async () => {
    const h = harness({ userId: 'customer', amount: 500 });
    await h.refundAs('support-agent', 100, 'SUPPORT');
    assert.equal(h.created.length, 1);
  });

  it('never lets the owner self-refund driver money', async () => {
    for (const purpose of ['DRIVER_COMMISSION_RECHARGE', 'DRIVER_SUBSCRIPTION_PAYMENT']) {
      const h = harness({ userId: 'driver-user', amount: 500, purpose });
      await assert.rejects(h.refundAs('driver-user', 500), RefundNotAllowedError);
      assert.deepEqual(h.created, [], `${purpose}: nothing created`);
    }
  });

  it('lets only FINANCE staff refund driver money, never SUPPORT', async () => {
    const support = harness({
      userId: 'driver-user',
      amount: 500,
      purpose: 'DRIVER_COMMISSION_RECHARGE',
    });
    await assert.rejects(support.refundAs('support-agent', 500, 'SUPPORT'), RefundNotAllowedError);

    const finance = harness({
      userId: 'driver-user',
      amount: 500,
      purpose: 'DRIVER_COMMISSION_RECHARGE',
    });
    await finance.refundAs('finance-agent', 500, 'FINANCE');
    assert.equal(finance.created.length, 1);
  });

  it('records the refund against the PAYER, never the staff member asking', async () => {
    const h = harness({ userId: 'customer', amount: 500 });
    await h.refundAs('finance-agent', 100, 'FINANCE');
    assert.equal(h.created[0]?.userId, 'customer');
    assert.equal(h.debits[0]?.userId, 'customer', 'the customer’s wallet is reversed');
  });
});

describe('Refund bounds and state', () => {
  it('caps the refund at the STORED captured amount', async () => {
    const h = harness({ userId: 'user-1', amount: 500 });
    await assert.rejects(h.refundAs('user-1', 500.01), RefundNotAllowedError);
    assert.deepEqual(h.created, []);
  });

  it('still rejects a non-positive amount', async () => {
    const h = harness({ userId: 'user-1', amount: 500 });
    for (const amount of [0, -1]) {
      await assert.rejects(h.refundAs('user-1', amount), RefundNotAllowedError);
    }
    assert.deepEqual(h.created, []);
  });

  it('refuses a payment that was not captured', async () => {
    const h = harness({ userId: 'user-1', amount: 500, status: 'FAILED' });
    await assert.rejects(h.refundAs('user-1', 100), RefundNotAllowedError);
  });

  it('refuses a ride-linked payment', async () => {
    const h = harness({ userId: 'user-1', amount: 500, rideId: 'ride_1' });
    await assert.rejects(h.refundAs('user-1', 100), RefundNotAllowedError);
  });

  it('refuses a subscription refund that is not the full amount', async () => {
    const h = harness({
      userId: 'driver-user',
      amount: 500,
      purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
    });
    await assert.rejects(h.refundAs('finance-agent', 200, 'FINANCE'), /in full/);
  });
});

describe('Refund provider addressing', () => {
  it('sends the PROVIDER payment id, never our transaction id', async () => {
    const h = harness({
      userId: 'user-1',
      amount: 500,
      gateway: 'razorpay',
      gatewayTxnId: 'pay_ABC',
    });
    await h.refundAs('user-1', 100);
    assert.equal(h.providerCalls[0]?.providerPaymentId, 'pay_ABC');
    assert.notEqual(h.providerCalls[0]?.providerPaymentId, 'txn_1');
    assert.equal(h.providerCalls[0]?.refundReference, 'rf_1', 'our refund id is the reference');
  });

  it('refuses a Razorpay payment whose stored id is not a pay_ id', async () => {
    for (const gatewayTxnId of ['order_123', 'txn_1', null]) {
      const h = harness({ userId: 'user-1', amount: 500, gateway: 'razorpay', gatewayTxnId });
      await assert.rejects(h.refundAs('user-1', 100), RefundNotAllowedError);
      assert.deepEqual(h.providerCalls, []);
    }
  });

  it('accepts a Stripe charge or PaymentIntent id', async () => {
    for (const gatewayTxnId of ['ch_1', 'pi_1']) {
      const h = harness({ userId: 'user-1', amount: 500, gateway: 'stripe', gatewayTxnId });
      await h.refundAs('user-1', 100);
      assert.equal(h.providerCalls.length, 1);
    }
  });
});

describe('Refund unknown outcomes', () => {
  it('keeps a timed-out refund PROCESSING, never FAILED', async () => {
    const h = harness({ userId: 'user-1', amount: 500 }, 'TIMEOUT');
    const result = await h.refundAs('user-1', 100);
    assert.equal(result.status, 'PROCESSING');
  });

  it('fails a refund the provider definitively rejects', async () => {
    const h = harness({ userId: 'user-1', amount: 500 }, 'REJECT');
    const result = await h.refundAs('user-1', 100);
    assert.equal(result.status, 'FAILED');
  });

  it('leaves the refund PROCESSING when recording the provider success fails', async () => {
    const h = harness({ userId: 'user-1', amount: 500 }, 'APPLY_FAILS_ONCE');
    const result = await h.refundAs('user-1', 100);
    assert.equal(result.status, 'PROCESSING', 'reconciliation will pick it up');
    assert.equal(h.providerCalls.length, 1);
  });
});
