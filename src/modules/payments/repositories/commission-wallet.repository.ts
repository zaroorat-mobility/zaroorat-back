import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverCommissionWallet, DriverCommissionWalletTransaction } from '../types';

/// Owns the one write path onto `driver_commission_wallets.balance` —
/// `drivers` gets a read-only view (`DriverCommissionWalletViewService`),
/// mirroring exactly how `SettlementWalletRepository` owns `driver_wallets`
/// while the drivers module's own repository stays read-only (constitution §1.4).
export class CommissionWalletRepository {
  constructor(private readonly db: DatabaseService) {}

  async getOrCreateWallet(
    driverId: string,
    tx?: TransactionClient,
  ): Promise<DriverCommissionWallet> {
    const client = tx ?? this.db.client;
    const existing = await client.driverCommissionWallet.findUnique({ where: { driverId } });
    if (existing) return existing;
    return client.driverCommissionWallet.create({
      data: {
        driverId,
        balance: new Decimal(0),
        currency: 'INR',
      },
    });
  }

  async lockForUpdate(
    driverId: string,
    tx: TransactionClient,
  ): Promise<DriverCommissionWallet | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "driver_commission_wallets" WHERE "driver_id" = ${driverId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.driverCommissionWallet.findUnique({ where: { driverId } });
  }

  async updateBalance(walletId: string, balance: Decimal, tx: TransactionClient): Promise<void> {
    await tx.driverCommissionWallet.update({
      where: { id: walletId },
      data: { balance, lastTransactionAt: new Date() },
    });
  }

  /// Existence of a `RIDE_COMMISSION` row for a ride IS the idempotency check
  /// (spec.md FR-021) — backed by the `commission_wallet_one_deduction_per_ride`
  /// partial unique index as the hard, crash-survivable backstop.
  async findRideCommissionTransaction(
    rideId: string,
    tx?: TransactionClient,
  ): Promise<DriverCommissionWalletTransaction | null> {
    const client = tx ?? this.db.client;
    return client.driverCommissionWalletTransaction.findFirst({
      where: { rideId, txnType: 'RIDE_COMMISSION' },
    });
  }

  async recordTransaction(
    data: {
      walletId: string;
      driverId: string;
      rideId?: string | null;
      txnType: string;
      amount: Decimal;
      balanceAfter: Decimal;
      referenceType?: string | null;
      referenceId?: string | null;
      description?: string | null;
    },
    tx: TransactionClient,
  ): Promise<DriverCommissionWalletTransaction> {
    return tx.driverCommissionWalletTransaction.create({
      data: {
        walletId: data.walletId,
        driverId: data.driverId,
        rideId: data.rideId ?? null,
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
    driverId: string,
    limit = 50,
    tx?: TransactionClient,
  ): Promise<DriverCommissionWalletTransaction[]> {
    const client = tx ?? this.db.client;
    return client.driverCommissionWalletTransaction.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
