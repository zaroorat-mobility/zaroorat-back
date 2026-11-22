import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { CustomerWallet, CustomerWalletTransaction, WalletHold } from '../types';
export class WalletRepository {
  constructor(private readonly db: DatabaseService) {}
  async findByUserId(userId: string, tx?: TransactionClient): Promise<CustomerWallet | null> {
    const client = tx ?? this.db.client;
    return client.customerWallet.findUnique({
      where: { userId },
    });
  }
  async lockForUpdate(userId: string, tx: TransactionClient): Promise<CustomerWallet | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "customer_wallets" WHERE "user_id" = ${userId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.customerWallet.findUnique({ where: { userId } });
  }
  async getOrCreateWallet(userId: string, tx?: TransactionClient): Promise<CustomerWallet> {
    const client = tx ?? this.db.client;
    const existing = await client.customerWallet.findUnique({ where: { userId } });
    if (existing) return existing;
    return client.customerWallet.create({
      data: {
        userId,
        balance: new Decimal(0),
        lockedBalance: new Decimal(0),
        currency: 'INR',
      },
    });
  }
  async updateBalances(
    walletId: string,
    balance: Decimal,
    lockedBalance: Decimal,
    tx: TransactionClient,
  ): Promise<CustomerWallet> {
    return tx.customerWallet.update({
      where: { id: walletId },
      data: {
        balance,
        lockedBalance,
        lastTransactionAt: new Date(),
      },
    });
  }
  async recordTransaction(
    data: {
      walletId: string;
      userId: string;
      txnType: string;
      amount: Decimal;
      balanceAfter: Decimal;
      referenceType?: string | null;
      referenceId?: string | null;
      description?: string | null;
    },
    tx: TransactionClient,
  ): Promise<CustomerWalletTransaction> {
    return tx.customerWalletTransaction.create({
      data: {
        walletId: data.walletId,
        userId: data.userId,
        txnType: data.txnType,
        amount: data.amount,
        balanceAfter: data.balanceAfter,
        referenceType: data.referenceType ?? null,
        referenceId: data.referenceId ?? null,
        description: data.description ?? null,
      },
    });
  }
  async listTransactions(
    walletId: string,
    limit = 50,
    tx?: TransactionClient,
  ): Promise<CustomerWalletTransaction[]> {
    const client = tx ?? this.db.client;
    return client.customerWalletTransaction.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
  async releaseHold(holdId: string, tx: TransactionClient): Promise<WalletHold> {
    return tx.walletHold.update({
      where: { id: holdId },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
      },
    });
  }
}
