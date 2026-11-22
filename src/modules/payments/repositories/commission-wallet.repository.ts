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

  /// Phase 4 (M-05): Independent idempotency check for RIDE_GST_RECOVERY — backed by
  /// the `commission_wallet_one_gst_recovery_per_ride` partial unique index.
  async findRideGstRecoveryTransaction(
    rideId: string,
    tx?: TransactionClient,
  ): Promise<DriverCommissionWalletTransaction | null> {
    const client = tx ?? this.db.client;
    return client.driverCommissionWalletTransaction.findFirst({
      where: { rideId, txnType: 'RIDE_GST_RECOVERY' },
    });
  }

  /// Sums all ACTIVE wallet reservations for a driver (called under wallet FOR UPDATE lock).
  async sumActiveReservations(driverId: string, tx?: TransactionClient): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const agg = await client.driverWalletReservation.aggregate({
      where: { driverId, status: 'ACTIVE' },
      _sum: { totalReservedAmount: true },
    });
    return agg._sum.totalReservedAmount ?? new Decimal(0);
  }

  async findReservationByRide(rideId: string, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    return client.driverWalletReservation.findUnique({ where: { rideId } });
  }

  async lockReservationForUpdate(rideId: string, tx: TransactionClient) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "driver_wallet_reservations" WHERE "ride_id" = ${rideId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return null;
    return tx.driverWalletReservation.findUnique({ where: { rideId } });
  }

  async createReservation(
    data: {
      rideId: string;
      driverId: string;
      commissionAmount: Decimal;
      gstRecoveryAmount: Decimal;
      totalReservedAmount: Decimal;
    },
    tx: TransactionClient,
  ) {
    return tx.driverWalletReservation.create({
      data: {
        rideId: data.rideId,
        driverId: data.driverId,
        commissionAmount: data.commissionAmount,
        gstRecoveryAmount: data.gstRecoveryAmount,
        totalReservedAmount: data.totalReservedAmount,
        revision: 1,
        status: 'ACTIVE',
      },
    });
  }

  async updateReservationAmounts(
    rideId: string,
    data: {
      commissionAmount: Decimal;
      gstRecoveryAmount: Decimal;
      totalReservedAmount: Decimal;
    },
    tx: TransactionClient,
  ) {
    return tx.driverWalletReservation.update({
      where: { rideId },
      data: {
        commissionAmount: data.commissionAmount,
        gstRecoveryAmount: data.gstRecoveryAmount,
        totalReservedAmount: data.totalReservedAmount,
        revision: { increment: 1 },
      },
    });
  }

  async resolveReservation(
    rideId: string,
    status: 'CONSUMED' | 'RELEASED',
    tx: TransactionClient,
  ): Promise<number> {
    const result = await tx.driverWalletReservation.updateMany({
      where: { rideId, status: 'ACTIVE' },
      data: { status, resolvedAt: new Date() },
    });
    return result.count;
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
  ): Promise<
    (DriverCommissionWalletTransaction & {
      ride?: { id: string; pickupAddress: string | null; dropAddress: string | null } | null;
    })[]
  > {
    const client = tx ?? this.db.client;
    return client.driverCommissionWalletTransaction.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        ride: {
          select: {
            id: true,
            pickupAddress: true,
            dropAddress: true,
          },
        },
      },
    });
  }
}
