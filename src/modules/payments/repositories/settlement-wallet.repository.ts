import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal, type DriverWallet } from '../types/index.js';
/// Owns the one write path onto `driver_wallets.balance`. `drivers` owns a
/// same-named table's *read* model (`DriverWalletViewService`) deliberately —
/// financial mutation belongs in `payments`, per this platform's module
/// boundaries, so that repository never gained an update method and this one
/// does instead.
export class SettlementWalletRepository {
  constructor(private readonly db: DatabaseService) {}
  async getOrCreateWallet(driverId: string, tx?: TransactionClient): Promise<DriverWallet> {
    const client = tx ?? this.db.client;
    const existing = await client.driverWallet.findUnique({ where: { driverId } });
    if (existing) return existing;
    return client.driverWallet.create({
      data: { driverId, balance: new Decimal(0), lockedBalance: new Decimal(0), currency: 'INR' },
    });
  }
  async lockForUpdate(driverId: string, tx: TransactionClient): Promise<DriverWallet | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "driver_wallets" WHERE "driver_id" = ${driverId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.driverWallet.findUnique({ where: { driverId } });
  }
  async credit(
    data: {
      driverId: string;
      amount: Decimal;
      referenceType: string;
      referenceId: string;
      description: string;
      txnType?: 'RIDE_EARNING' | 'BONUS' | 'INCENTIVE' | 'REFUND' | 'ADJUSTMENT';
    },
    tx: TransactionClient,
  ): Promise<DriverWallet> {
    await this.getOrCreateWallet(data.driverId, tx);
    const wallet = await this.lockForUpdate(data.driverId, tx);
    if (!wallet) throw new Error(`Driver wallet for driver "${data.driverId}" could not be locked`);
    const newBalance = wallet.balance.add(data.amount);
    const updated = await tx.driverWallet.update({
      where: { driverId: data.driverId },
      data: { balance: newBalance, lastTransactionAt: new Date() },
    });
    await tx.driverWalletTransaction.create({
      data: {
        walletId: wallet.id,
        driverId: data.driverId,
        txnType: data.txnType ?? 'RIDE_EARNING',
        amount: data.amount,
        balanceAfter: newBalance,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        description: data.description,
      },
    });
    return updated;
  }

  /// Takes the platform's share of a cash ride out of a driver's balance, and
  /// is allowed to leave it negative.
  ///
  /// That share is tax and the platform fee always, plus commission too but
  /// only for a legacy, no-payment-model ride — a COMMISSION/SUBSCRIPTION
  /// ride's commission is never collected through this mechanism (see
  /// `RideCollectionService.confirmCash` / `LifecycleService`). The negative
  /// balance this can leave is not an error state — it is what the driver
  /// still owes for holding 100% of a cash fare the platform has a share of.
  /// It clears when the next settlement credits their earnings
  /// (FR-020/FR-021), which is why there is no floor here to mirror the
  /// customer wallet's.
  async debit(
    data: {
      driverId: string;
      amount: Decimal;
      referenceType: string;
      referenceId: string;
      description: string;
    },
    tx: TransactionClient,
  ): Promise<DriverWallet> {
    await this.getOrCreateWallet(data.driverId, tx);
    const wallet = await this.lockForUpdate(data.driverId, tx);
    if (!wallet) throw new Error(`Driver wallet for driver "${data.driverId}" could not be locked`);
    const newBalance = wallet.balance.sub(data.amount);
    const updated = await tx.driverWallet.update({
      where: { driverId: data.driverId },
      data: { balance: newBalance, lastTransactionAt: new Date() },
    });
    await tx.driverWalletTransaction.create({
      data: {
        walletId: wallet.id,
        driverId: data.driverId,
        // The enum has no COMMISSION member and this needs no migration to
        // work: an amount the platform takes back off the driver is exactly
        // what PENALTY already means here.
        txnType: 'PENALTY',
        // Negative, matching the customer wallet's convention: reconciliation
        // sums this column, so a positive debit would report a mismatch on
        // correct data.
        amount: data.amount.neg(),
        balanceAfter: newBalance,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        description: data.description,
      },
    });
    return updated;
  }
}
