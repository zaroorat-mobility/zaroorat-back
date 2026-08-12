import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal } from '../../../src/modules/payments/types/index.js';
import {
  LedgerRepository,
  type LedgerItemInput,
} from '../../../src/modules/payments/repositories/ledger.repository.js';
import { LedgerImbalanceError } from '../../../src/modules/payments/errors/payment.errors.js';

describe('Ledger Invariant & Double-Entry Tests', () => {
  it('accepts balanced entry group where sum(debits) == sum(credits)', async () => {
    const created: Record<string, unknown>[] = [];
    const mockTx = {
      paymentLedgerEntry: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'entry-1', ...data };
        },
      },
    };

    const repo = new LedgerRepository({} as never);

    const items: LedgerItemInput[] = [
      { account: 'CUSTOMER_WALLET', direction: 'DEBIT', amount: new Decimal(500) },
      { account: 'DRIVER_PAYABLE', direction: 'CREDIT', amount: new Decimal(400) },
      { account: 'PLATFORM_COMMISSION', direction: 'CREDIT', amount: new Decimal(100) },
    ];

    const result = await repo.postGroup(items, mockTx as never);
    assert.equal(result.length, 3);
    assert.equal(created.length, 3);
  });

  it('rejects imbalanced entry group where sum(debits) != sum(credits)', async () => {
    const mockTx = {
      paymentLedgerEntry: { create: async () => ({}) },
    };

    const repo = new LedgerRepository({} as never);

    const items: LedgerItemInput[] = [
      { account: 'CUSTOMER_WALLET', direction: 'DEBIT', amount: new Decimal(500) },
      { account: 'DRIVER_PAYABLE', direction: 'CREDIT', amount: new Decimal(400) },
    ];

    await assert.rejects(
      async () => repo.postGroup(items, mockTx as never),
      (err: unknown) => {
        assert.ok(err instanceof LedgerImbalanceError);
        return true;
      },
    );
  });
});
