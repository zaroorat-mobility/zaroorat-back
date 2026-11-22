import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal } from '../../../src/modules/payments/types/index.js';
import { WalletService } from '../../../src/modules/payments/services/wallet/wallet.service.js';
import { InsufficientBalanceError } from '../../../src/modules/payments/errors/payment.errors.js';

interface Recorded {
  txnType: string;
  amount: Decimal;
  balanceAfter: Decimal;
}

function makeService(balance: number, lockedBalance = 0) {
  const state = { balance: new Decimal(balance), locked: new Decimal(lockedBalance) };
  const transactions: Recorded[] = [];
  const published: string[] = [];
  const wallet = () => ({ id: 'w-1', userId: 'user-1', ...state, lockedBalance: state.locked });

  const walletRepo = {
    getOrCreateWallet: async () => wallet(),
    lockForUpdate: async () => wallet(),
    updateBalances: async (_id: string, b: Decimal, l: Decimal) => {
      state.balance = b;
      state.locked = l;
      return wallet();
    },
    recordTransaction: async (data: Recorded) => {
      transactions.push(data);
      return data;
    },
  };

  const service = new WalletService(
    walletRepo as never,
    {} as never,
    { publish: async (input: { type: string }) => published.push(input.type) } as never,
    { insufficientBalance: () => {} } as never,
  );

  return { service, state, transactions, published };
}

const TX = {} as never;
const REFERENCE = { referenceType: 'RIDE', referenceId: 'ride-1' };

describe('wallet debit', () => {
  it('records a negative transaction amount', async () => {
    const { service, state, transactions } = makeService(1000);

    await service.debitInTx('user-1', new Decimal(250), TX, REFERENCE);

    assert.equal(state.balance.toNumber(), 750);
    assert.equal(transactions.length, 1);
    // ReconciliationJob sums this column against the ledger position. A
    // positive debit here reports a mismatch on data that is actually correct.
    assert.equal(transactions[0]?.amount.toNumber(), -250, 'a debit is negative');
    assert.equal(transactions[0]?.balanceAfter.toNumber(), 750);
  });

  it('publishes payment.wallet.debited', async () => {
    const { service, published } = makeService(1000);

    await service.debitInTx('user-1', new Decimal(10), TX, REFERENCE);

    assert.deepEqual(published, ['payment.wallet.debited']);
  });

  it('rejects a debit larger than the balance, and mutates nothing', async () => {
    const { service, state, transactions, published } = makeService(100);

    await assert.rejects(
      () => service.debitInTx('user-1', new Decimal(100.01), TX, REFERENCE),
      InsufficientBalanceError,
    );

    assert.equal(state.balance.toNumber(), 100, 'the balance is untouched');
    assert.equal(transactions.length, 0, 'nothing was recorded');
    assert.equal(published.length, 0, 'nothing was announced');
  });

  it('treats locked funds as unavailable', async () => {
    // 500 on the books, 400 promised to a hold — only 100 is spendable.
    const { service } = makeService(500, 400);

    await assert.rejects(
      () => service.debitInTx('user-1', new Decimal(150), TX, REFERENCE),
      InsufficientBalanceError,
    );
    await service.debitInTx('user-1', new Decimal(100), TX, REFERENCE);
  });

  it('refuses a non-positive amount', async () => {
    const { service, transactions } = makeService(1000);

    await assert.rejects(() => service.debitInTx('user-1', new Decimal(0), TX, REFERENCE));
    await assert.rejects(() => service.debitInTx('user-1', new Decimal(-5), TX, REFERENCE));
    assert.equal(transactions.length, 0);
  });
});

describe('wallet credit', () => {
  it('records a positive transaction and raises the balance', async () => {
    const { service, state, transactions, published } = makeService(0);

    await service.creditInTx('user-1', new Decimal(500), TX, {
      referenceType: 'PAYMENT_INTENT',
      referenceId: 'intent-1',
    });

    assert.equal(state.balance.toNumber(), 500);
    assert.equal(transactions[0]?.amount.toNumber(), 500);
    assert.deepEqual(published, ['payment.wallet.credited']);
  });

  it('refuses a non-positive amount', async () => {
    const { service } = makeService(0);
    await assert.rejects(() =>
      service.creditInTx('user-1', new Decimal(0), TX, { referenceType: 'PAYMENT_INTENT' }),
    );
  });
});
