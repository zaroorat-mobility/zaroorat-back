import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Decimal } from '../../../src/modules/payments/types/index.js';
import { WalletService } from '../../../src/modules/payments/services/wallet/wallet.service.js';
import { InsufficientBalanceError } from '../../../src/modules/payments/errors/payment.errors.js';

describe('Wallet Concurrency & Over-spend Protection Tests', () => {
  it('prevents over-spending when concurrent holds exceed available balance', async () => {
    let mockBalance = new Decimal(1000);
    let mockLocked = new Decimal(0);

    const mockTxManager = {
      execute: async (fn: (tx: unknown) => unknown) =>
        fn({
          walletHold: {
            create: async ({ data }: { data: Record<string, unknown> }) => ({
              id: 'hold-1',
              ...data,
            }),
          },
        }),
    };

    const mockWalletRepo = {
      getOrCreateWallet: async () => ({
        id: 'w-1',
        balance: mockBalance,
        lockedBalance: mockLocked,
      }),
      lockForUpdate: async () => ({ id: 'w-1', balance: mockBalance, lockedBalance: mockLocked }),
      updateBalances: async (id: string, b: Decimal, l: Decimal) => {
        mockBalance = b;
        mockLocked = l;
      },
      createHold: async (data: Record<string, unknown>) => ({ id: 'hold-1', ...data }),
    };

    const mockMetrics = { insufficientBalance: () => {} };
    const mockEvents = { publish: async () => {} };

    const walletService = new WalletService(
      mockWalletRepo as never,
      {} as never,
      mockTxManager as never,
      mockEvents as never,
      mockMetrics as never,
    );

    await walletService.hold('user-1', new Decimal(700), 'Ride hold');
    assert.equal(mockLocked.toNumber(), 700);

    await assert.rejects(
      async () => walletService.hold('user-1', new Decimal(700), 'Second ride hold'),
      (err: unknown) => {
        assert.ok(err instanceof InsufficientBalanceError);
        return true;
      },
    );
  });
});
