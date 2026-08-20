import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decimal } from '../../../src/modules/payments/types/index.js';
import { RefundService } from '../../../src/modules/payments/services/refund/refund.service.js';
import { RefundNotAllowedError } from '../../../src/modules/payments/errors/payment.errors.js';

function harness(transaction: { userId: string; amount: number } | null) {
  const created: { userId: string; amount: Decimal }[] = [];

  const refundRepo = {
    async findByIdempotencyKey() {
      return null;
    },
    async findTransactionForRefund() {
      return transaction
        ? {
            id: 'txn_1',
            userId: transaction.userId,
            amount: new Decimal(transaction.amount),
            status: 'SUCCEEDED',
          }
        : null;
    },
    async getTotalRefundedForTransaction() {
      return new Decimal(0);
    },
    async create(data: { userId: string; amount: Decimal }) {
      created.push(data);
      return { id: 'rf_1', ...data, status: 'PENDING' };
    },
    async updateStatus() {
      return { id: 'rf_1' };
    },
  };

  const service = new RefundService(
    refundRepo as never,
    {
      gatewayName: 'mock',
      async createRefund() {
        return { gatewayRefundId: 'grf_1', status: 'SUCCEEDED' };
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
    { refundFailure() {}, refundSuccess() {}, refundProcessed() {} } as never,
  );

  return { service, created };
}

describe('Refund authorization', () => {
  it('refunds the caller’s own transaction', async () => {
    const h = harness({ userId: 'user-1', amount: 500 });
    await h.service.processRefund({
      transactionId: 'txn_1',
      userId: 'user-1',
      amount: new Decimal(100),
      idempotencyKey: 'key-1',
    });
    assert.equal(h.created.length, 1);
  });

  it('refuses to refund another user’s transaction', async () => {
    const h = harness({ userId: 'victim', amount: 500 });

    await assert.rejects(
      () =>
        h.service.processRefund({
          transactionId: 'txn_1',
          userId: 'attacker',
          amount: new Decimal(100),
          idempotencyKey: 'key-2',
        }),
      (err: unknown) => err instanceof RefundNotAllowedError,
    );
    assert.deepEqual(h.created, []);
  });

  it('gives the same answer for a foreign and a missing transaction', async () => {
    const foreign = harness({ userId: 'victim', amount: 500 });
    const missing = harness(null);

    const errors: string[] = [];
    for (const h of [foreign, missing]) {
      await h.service
        .processRefund({
          transactionId: 'txn_1',
          userId: 'attacker',
          amount: new Decimal(100),
          idempotencyKey: 'key-3',
        })
        .catch((err: Error) => errors.push(err.message));
    }
    assert.equal(errors.length, 2);
    assert.equal(errors[0], errors[1]);
  });

  it('permits staff to refund on a customer’s behalf', async () => {
    const h = harness({ userId: 'customer', amount: 500 });
    await h.service.processRefund({
      transactionId: 'txn_1',
      userId: 'ops-agent',
      amount: new Decimal(100),
      idempotencyKey: 'key-4',
      actorIsStaff: true,
    });
    assert.equal(h.created.length, 1);
  });

  it('caps the refund at the STORED captured amount', async () => {
    const h = harness({ userId: 'user-1', amount: 500 });

    await assert.rejects(
      () =>
        h.service.processRefund({
          transactionId: 'txn_1',
          userId: 'user-1',
          amount: new Decimal(999_999),
          idempotencyKey: 'key-5',
        }),
      (err: unknown) =>
        err instanceof RefundNotAllowedError && /exceeds/i.test((err as Error).message),
    );
    assert.deepEqual(h.created, []);
  });

  it('still rejects a non-positive amount', async () => {
    const h = harness({ userId: 'user-1', amount: 500 });
    for (const amount of [0, -50]) {
      await assert.rejects(
        () =>
          h.service.processRefund({
            transactionId: 'txn_1',
            userId: 'user-1',
            amount: new Decimal(amount),
            idempotencyKey: `key-neg-${amount}`,
          }),
        (err: unknown) => err instanceof RefundNotAllowedError,
      );
    }
  });
});
