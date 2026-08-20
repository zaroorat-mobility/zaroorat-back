import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { WalletRepository } from '../../repositories/wallet.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InsufficientBalanceError } from '../../errors/payment.errors.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { CustomerWallet, WalletHold } from '../../types';
export class WalletService {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}
  async getWallet(userId: string): Promise<CustomerWallet> {
    return this.walletRepository.getOrCreateWallet(userId);
  }
  async topup(
    userId: string,
    amount: Decimal,
    referenceId?: string,
    description?: string,
  ): Promise<CustomerWallet> {
    if (amount.lte(0)) {
      throw new Error('Top-up amount must be greater than zero');
    }
    return this.txManager.execute(async (tx) => {
      const wallet = await this.walletRepository.getOrCreateWallet(userId, tx);
      const lockedWallet = await this.walletRepository.lockForUpdate(userId, tx);
      const currentBalance = lockedWallet ? lockedWallet.balance : wallet.balance;
      const currentLocked = lockedWallet ? lockedWallet.lockedBalance : wallet.lockedBalance;
      const newBalance = currentBalance.add(amount);
      const updated = await this.walletRepository.updateBalances(
        wallet.id,
        newBalance,
        currentLocked,
        tx,
      );
      await this.walletRepository.recordTransaction(
        {
          walletId: wallet.id,
          userId,
          txnType: 'TOPUP',
          amount,
          balanceAfter: newBalance,
          referenceType: 'TOPUP',
          referenceId: referenceId ?? null,
          description: description ?? 'Wallet Top-up',
        },
        tx,
      );
      await this.ledgerService.postTransactionGroup(
        [
          {
            account: 'GATEWAY_CLEARING',
            direction: 'DEBIT',
            amount,
            referenceType: 'TOPUP',
            referenceId: referenceId ?? wallet.id,
            description: 'Gateway funds received for topup',
          },
          {
            account: 'CUSTOMER_WALLET',
            accountRefId: userId,
            direction: 'CREDIT',
            amount,
            referenceType: 'TOPUP',
            referenceId: referenceId ?? wallet.id,
            description: 'Customer wallet credited from topup',
          },
        ],
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
    });
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
