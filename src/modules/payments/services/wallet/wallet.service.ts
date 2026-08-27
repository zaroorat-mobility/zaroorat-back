import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { WalletRepository } from '../../repositories/wallet.repository.js';
import { InsufficientBalanceError } from '../../errors/payment.errors.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { CustomerWallet, WalletHold } from '../../types';
export class WalletService {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}
  async getWallet(userId: string): Promise<CustomerWallet> {
    return this.walletRepository.getOrCreateWallet(userId);
  }
  /// Credits a wallet inside a transaction the caller already owns.
  ///
  /// It deliberately does **not** post a ledger group. Every legitimate credit
  /// has a funding event behind it that posts its own balanced group — a
  /// gateway confirmation debits `GATEWAY_CLEARING` and credits
  /// `CUSTOMER_WALLET` — and posting a second group here would credit the same
  /// account twice for one payment. Requiring the caller's `tx` is what keeps
  /// the balance and that group inseparable: they commit together or not at
  /// all, which is the structural discharge of FR-036.
  ///
  /// This replaced a standalone `topup()` that mutated the balance with no
  /// provider payment behind it at all.
  async creditInTx(
    userId: string,
    amount: Decimal,
    tx: TransactionClient,
    reference: {
      referenceType: string;
      referenceId?: string | null;
      description?: string;
      txnType?: string;
    } = {
      referenceType: 'TOPUP',
    },
  ): Promise<CustomerWallet> {
    if (amount.lte(0)) {
      throw new Error('Credit amount must be greater than zero');
    }
    const wallet = await this.walletRepository.getOrCreateWallet(userId, tx);
    const locked = await this.walletRepository.lockForUpdate(userId, tx);
    const active = locked ?? wallet;
    const newBalance = active.balance.add(amount);
    const updated = await this.walletRepository.updateBalances(
      wallet.id,
      newBalance,
      active.lockedBalance,
      tx,
    );
    await this.walletRepository.recordTransaction(
      {
        walletId: wallet.id,
        userId,
        txnType: reference.txnType ?? 'TOPUP',
        amount,
        balanceAfter: newBalance,
        referenceType: reference.referenceType,
        referenceId: reference.referenceId ?? null,
        description: reference.description ?? 'Wallet credited',
      },
      tx,
    );
    await this.eventPublisher.publish(
      paymentEvent(PAYMENT_EVENT_CATALOG.WALLET_CREDITED, userId, {
        walletId: wallet.id,
        userId,
        amount: amount.toNumber(),
        newBalance: newBalance.toNumber(),
      }),
      tx,
    );
    return updated;
  }

  /// Debits a wallet inside a transaction the caller already owns.
  ///
  /// Same contract as `creditInTx`, and the same reason: a ride collection
  /// posts the `CUSTOMER_WALLET` debit through `recordTripPayment`, so posting
  /// one here would double-count the fare.
  ///
  /// The recorded transaction amount is **negative**. `ReconciliationJob` sums
  /// this column against the ledger position, so a positive debit would report
  /// a mismatch on correct data — which is why a unit test pins the sign.
  async debitInTx(
    userId: string,
    amount: Decimal,
    tx: TransactionClient,
    reference: { referenceType: string; referenceId?: string | null; description?: string },
  ): Promise<CustomerWallet> {
    if (amount.lte(0)) {
      throw new Error('Debit amount must be greater than zero');
    }
    const wallet = await this.walletRepository.getOrCreateWallet(userId, tx);
    const locked = await this.walletRepository.lockForUpdate(userId, tx);
    const active = locked ?? wallet;
    // Locked funds are already promised to something else, so the spendable
    // amount is the balance less the holds — the same reading `hold` uses.
    const available = active.balance.sub(active.lockedBalance);
    if (available.lt(amount)) {
      this.paymentMetrics.insufficientBalance({ userId });
      throw new InsufficientBalanceError();
    }
    const newBalance = active.balance.sub(amount);
    const updated = await this.walletRepository.updateBalances(
      wallet.id,
      newBalance,
      active.lockedBalance,
      tx,
    );
    await this.walletRepository.recordTransaction(
      {
        walletId: wallet.id,
        userId,
        txnType: 'DEBIT',
        amount: amount.neg(),
        balanceAfter: newBalance,
        referenceType: reference.referenceType,
        referenceId: reference.referenceId ?? null,
        description: reference.description ?? 'Wallet debited',
      },
      tx,
    );
    await this.eventPublisher.publish(
      paymentEvent(PAYMENT_EVENT_CATALOG.WALLET_DEBITED, userId, {
        walletId: wallet.id,
        userId,
        amount: amount.toNumber(),
        newBalance: newBalance.toNumber(),
      }),
      tx,
    );
    return updated;
  }
  async hold(
    userId: string,
    amount: Decimal,
    reason?: string,
    referenceId?: string,
  ): Promise<WalletHold> {
    if (amount.lte(0)) {
      throw new Error('Hold amount must be greater than zero');
    }
    return this.txManager.execute(async (tx) => {
      const wallet = await this.walletRepository.getOrCreateWallet(userId, tx);
      const locked = await this.walletRepository.lockForUpdate(userId, tx);
      const activeWallet = locked ?? wallet;
      const availableBalance = activeWallet.balance.sub(activeWallet.lockedBalance);
      if (availableBalance.lt(amount)) {
        this.paymentMetrics.insufficientBalance({ userId });
        throw new InsufficientBalanceError();
      }
      const newLockedBalance = activeWallet.lockedBalance.add(amount);
      await this.walletRepository.updateBalances(
        wallet.id,
        activeWallet.balance,
        newLockedBalance,
        tx,
      );
      const holdParams = {
        walletType: 'CUSTOMER',
        walletId: wallet.id,
        ownerId: userId,
        amount,
        referenceType: 'HOLD',
        ...(reason !== undefined ? { reason } : {}),
        ...(referenceId !== undefined ? { referenceId } : {}),
      };
      const holdRecord = await this.walletRepository.createHold(holdParams, tx);
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.WALLET_HOLD_CREATED, userId, {
          holdId: holdRecord.id,
          userId,
          amount: amount.toNumber(),
        }),
        tx,
      );
      return holdRecord;
    });
  }
  async releaseHold(userId: string, holdId: string): Promise<WalletHold> {
    return this.txManager.execute(async (tx) => {
      const wallet = await this.walletRepository.getOrCreateWallet(userId, tx);
      const locked = await this.walletRepository.lockForUpdate(userId, tx);
      const activeWallet = locked ?? wallet;
      const holdRecord = await tx.walletHold.findUnique({ where: { id: holdId } });
      if (!holdRecord || holdRecord.status !== 'ACTIVE') {
        throw new Error('Hold record not found or not active');
      }
      const newLockedBalance = Decimal.max(0, activeWallet.lockedBalance.sub(holdRecord.amount));
      await this.walletRepository.updateBalances(
        wallet.id,
        activeWallet.balance,
        newLockedBalance,
        tx,
      );
      const released = await this.walletRepository.releaseHold(holdId, tx);
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.WALLET_HOLD_RELEASED, userId, {
          holdId,
          userId,
          amount: holdRecord.amount.toNumber(),
        }),
        tx,
      );
      return released;
    });
  }
}
