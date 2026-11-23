import { Decimal } from '../../types/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { CommissionWalletRepository } from '../../repositories/commission-wallet.repository.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import {
  DestinationChangeInsufficientWalletCoverageError,
  InsufficientAvailableBalanceDueToReservationsError,
  RefundBalanceUnavailableError,
} from '../../errors/payment.errors.js';
import type { DriverCommissionWallet, DriverCommissionWalletTransaction } from '../../types';

export type CommissionDeductionResult =
  | { outcome: 'DEDUCTED'; amount: Decimal; transaction: DriverCommissionWalletTransaction }
  | { outcome: 'INSUFFICIENT_BALANCE'; commissionAmount: Decimal; actualBalance: Decimal }
  | { outcome: 'ALREADY_PROCESSED' };

/// spec.md FR-007–FR-024e / decisions.md BD-1/BD-4/BD-7. A commission-model
/// driver's Commission Wallet: a single balance, no locked/reserved portion
/// (no reservation/freeze — BD-4). Money moves only by recharge (`creditInTx`),
/// a ride's full, exact, once-only commission deduction (`deductInTx`), and —
/// Phase 1 — the refund of still-unused recharged credit
/// (`debitForRefundInTx` / `restoreRefundedCreditInTx`). There is deliberately
/// no `reserve`/`release` method and no partial ride-deduction path.
export class CommissionWalletService {
  constructor(
    private readonly commissionWalletRepository: CommissionWalletRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  async getWallet(driverId: string): Promise<DriverCommissionWallet> {
    return this.commissionWalletRepository.getOrCreateWallet(driverId);
  }

  async listTransactions(
    driverId: string,
    limit = 50,
  ): Promise<
    (DriverCommissionWalletTransaction & {
      ride?: { id: string; pickupAddress: string | null; dropAddress: string | null } | null;
    })[]
  > {
    return this.commissionWalletRepository.listTransactions(driverId, limit);
  }

  /// A plain, read-only comparison — spec.md FR-017a: "MUST NOT reserve, lock,
  /// freeze, or otherwise set aside any part of a commission-model driver's
  /// wallet balance at ride assignment/acceptance time." No lock is taken; no
  /// row is written. Called from `LifecycleService.acceptRideRequest`.
  async hasSufficientBalance(driverId: string, commissionAmount: Decimal): Promise<boolean> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId);
    const reserved = await this.commissionWalletRepository.sumActiveReservations(driverId);
    return wallet.balance.sub(reserved).gte(commissionAmount);
  }

  /// Rev 5 §1.6: Computes `availableBalance = balance - SUM(activeReservations)` inside
  /// a caller's transaction (always call after locking `driver_commission_wallets`).
  async getAvailableBalanceInTx(
    driverId: string,
    tx: TransactionClient,
  ): Promise<{ balance: Decimal; reservedAmount: Decimal; availableBalance: Decimal }> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;
    const reservedAmount = await this.commissionWalletRepository.sumActiveReservations(
      driverId,
      tx,
    );
    const availableBalance = Decimal.max(0, active.balance.sub(reservedAmount));
    return { balance: active.balance, reservedAmount, availableBalance };
  }

  /// Rev 5 §1.6: Atomic accept-time reservation covering all enabled wallet deductions
  /// (commission + GST recovery). Locks wallet row FOR UPDATE before checking availableBalance.
  async reserveForRideInTx(
    data: {
      driverId: string;
      rideId: string;
      commissionAmount: Decimal;
      gstRecoveryAmount: Decimal;
    },
    tx: TransactionClient,
  ) {
    const commission = Decimal.max(0, data.commissionAmount);
    const gstRecovery = Decimal.max(0, data.gstRecoveryAmount);
    const totalRequired = commission.add(gstRecovery);

    const { availableBalance, reservedAmount } = await this.getAvailableBalanceInTx(
      data.driverId,
      tx,
    );
    if (totalRequired.gt(0) && availableBalance.lt(totalRequired)) {
      throw new InsufficientAvailableBalanceDueToReservationsError(
        totalRequired.toFixed(2),
        availableBalance.toFixed(2),
        reservedAmount.toFixed(2),
      );
    }

    return this.commissionWalletRepository.createReservation(
      {
        rideId: data.rideId,
        driverId: data.driverId,
        commissionAmount: commission,
        gstRecoveryAmount: gstRecovery,
        totalReservedAmount: totalRequired,
      },
      tx,
    );
  }

  /// Rev 5 §1.7 (R5-4): Incremental re-reservation on destination/route/fare growth.
  /// Checks `availableBalance >= delta` when obligation increases; never allows negative wallet.
  async updateReservationDeltaInTx(
    data: {
      driverId: string;
      rideId: string;
      newCommissionAmount: Decimal;
      newGstRecoveryAmount: Decimal;
    },
    tx: TransactionClient,
  ): Promise<{
    reservationId: string;
    revision: number;
    previousReserved: Decimal;
    newReserved: Decimal;
    deltaReserved: Decimal;
  }> {
    const { availableBalance } = await this.getAvailableBalanceInTx(data.driverId, tx);
    const existing = await this.commissionWalletRepository.lockReservationForUpdate(
      data.rideId,
      tx,
    );

    const nextComm = Decimal.max(0, data.newCommissionAmount);
    const nextRec = Decimal.max(0, data.newGstRecoveryAmount);
    const nextTotal = nextComm.add(nextRec);
    const prevTotal = existing?.status === 'ACTIVE' ? existing.totalReservedAmount : new Decimal(0);
    const delta = nextTotal.sub(prevTotal);

    if (delta.gt(0) && availableBalance.lt(delta)) {
      throw new DestinationChangeInsufficientWalletCoverageError(
        delta.toFixed(2),
        availableBalance.toFixed(2),
      );
    }

    if (existing && existing.status === 'ACTIVE') {
      const updated = await this.commissionWalletRepository.updateReservationAmounts(
        data.rideId,
        {
          commissionAmount: nextComm,
          gstRecoveryAmount: nextRec,
          totalReservedAmount: nextTotal,
        },
        tx,
      );
      return {
        reservationId: updated.id,
        revision: updated.revision,
        previousReserved: prevTotal,
        newReserved: nextTotal,
        deltaReserved: delta,
      };
    }

    const created = await this.commissionWalletRepository.createReservation(
      {
        rideId: data.rideId,
        driverId: data.driverId,
        commissionAmount: nextComm,
        gstRecoveryAmount: nextRec,
        totalReservedAmount: nextTotal,
      },
      tx,
    );
    return {
      reservationId: created.id,
      revision: created.revision,
      previousReserved: prevTotal,
      newReserved: nextTotal,
      deltaReserved: delta,
    };
  }

  async consumeReservationInTx(rideId: string, tx: TransactionClient): Promise<number> {
    await this.commissionWalletRepository.lockReservationForUpdate(rideId, tx);
    return this.commissionWalletRepository.resolveReservation(rideId, 'CONSUMED', tx);
  }

  async releaseReservationInTx(rideId: string, tx: TransactionClient): Promise<number> {
    await this.commissionWalletRepository.lockReservationForUpdate(rideId, tx);
    return this.commissionWalletRepository.resolveReservation(rideId, 'RELEASED', tx);
  }

  /// Credits a wallet recharge inside a transaction the caller already owns —
  /// same contract as `WalletService.creditInTx`: the caller posts the
  /// matching ledger group in the same transaction, so the balance and the
  /// ledger commit together or not at all.
  async creditInTx(
    driverId: string,
    amount: Decimal,
    tx: TransactionClient,
    reference: {
      referenceType: string;
      referenceId?: string | null;
      description?: string;
    },
  ): Promise<DriverCommissionWallet> {
    if (amount.lte(0)) {
      throw new Error('Credit amount must be greater than zero');
    }
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;
    const newBalance = active.balance.add(amount);
    await this.commissionWalletRepository.updateBalance(wallet.id, newBalance, tx);
    await this.commissionWalletRepository.recordTransaction(
      {
        walletId: wallet.id,
        driverId,
        txnType: 'MANUAL_RECHARGE',
        amount,
        balanceAfter: newBalance,
        referenceType: reference.referenceType,
        referenceId: reference.referenceId ?? null,
        description: reference.description ?? 'Commission wallet recharged',
      },
      tx,
    );
    this.paymentMetrics.commissionWalletRecharge({ driverId });
    await this.eventPublisher.publish(
      paymentEvent(PAYMENT_EVENT_CATALOG.DRIVER_COMMISSION_WALLET_CREDITED, driverId, {
        driverId,
        walletId: wallet.id,
        amount: amount.toNumber(),
        newBalance: newBalance.toNumber(),
      }),
      tx,
    );
    return { ...active, balance: newBalance };
  }

  /// Phase 1 refunds — reverses recharged credit that is still UNUSED.
  ///
  /// Commission credit is prepaid platform commission, so a refund can only
  /// return what has not already paid for rides; anything more would hand the
  /// driver back money the platform already earned. Called by `RefundService`
  /// when it reserves a DRIVER_COMMISSION_RECHARGE refund, in the same
  /// transaction as the matching ledger reservation. This is a refund, not a
  /// ride commission: it never touches `deductInTx` or its per-ride index.
  async debitForRefundInTx(
    driverId: string,
    amount: Decimal,
    tx: TransactionClient,
    reference: { referenceId: string; description: string },
  ): Promise<void> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;
    const reserved = await this.commissionWalletRepository.sumActiveReservations(driverId, tx);
    const available = active.balance.sub(reserved);
    if (available.lt(amount)) {
      if (reserved.gt(0) && active.balance.gte(amount)) {
        throw new InsufficientAvailableBalanceDueToReservationsError(
          amount.toFixed(2),
          Decimal.max(0, available).toFixed(2),
          reserved.toFixed(2),
        );
      }
      throw new RefundBalanceUnavailableError(amount.toFixed(2), active.balance.toFixed(2));
    }
    const newBalance = active.balance.sub(amount);
    await this.commissionWalletRepository.updateBalance(wallet.id, newBalance, tx);
    await this.commissionWalletRepository.recordTransaction(
      {
        walletId: wallet.id,
        driverId,
        txnType: 'REFUND',
        amount: amount.neg(),
        balanceAfter: newBalance,
        referenceType: 'REFUND',
        referenceId: reference.referenceId,
        description: reference.description,
      },
      tx,
    );
  }

  /// Puts refunded credit back when the provider refuses the refund.
  async restoreRefundedCreditInTx(
    driverId: string,
    amount: Decimal,
    tx: TransactionClient,
    reference: { referenceId: string; description: string },
  ): Promise<void> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;
    const newBalance = active.balance.add(amount);
    await this.commissionWalletRepository.updateBalance(wallet.id, newBalance, tx);
    await this.commissionWalletRepository.recordTransaction(
      {
        walletId: wallet.id,
        driverId,
        txnType: 'REFUND_REVERSAL',
        amount,
        balanceAfter: newBalance,
        referenceType: 'REFUND',
        referenceId: reference.referenceId,
        description: reference.description,
      },
      tx,
    );
  }

  /// spec.md FR-020–FR-024e / decisions.md BD-1 (reversed) — the sole
  /// commission-deduction operation. `commissionAmount` is supplied by the
  /// caller as `ride.commissionAmount`, read from the ride row; this method
  /// performs NO calculation of its own (BD-7).
  ///
  /// Exactly two money-affecting outcomes exist:
  ///   - the FULL amount is deducted (wallet covers it), or
  ///   - NOTHING is deducted (wallet doesn't cover it) — an exceptional
  ///     invariant violation, never a partial/capped amount.
  /// There is no third outcome and no `min()`/capping branch anywhere here.
  async deductInTx(
    driverId: string,
    rideId: string,
    commissionAmount: Decimal,
    tx: TransactionClient,
  ): Promise<CommissionDeductionResult> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;

    // FR-021 idempotency check, taken AFTER the lock: a concurrent retry for
    // the same ride blocks on the row lock above until the first invocation
    // commits, then finds the row this check is looking for.
    const existing = await this.commissionWalletRepository.findRideCommissionTransaction(
      rideId,
      tx,
    );
    if (existing) {
      return { outcome: 'ALREADY_PROCESSED' };
    }

    // FR-024a1: a determined commission of zero or negative deducts exactly
    // zero — the full (zero) stored amount, not a partial deduction of a
    // positive one. Never a negative deduction (never credits the wallet).
    const toDeduct = Decimal.max(0, commissionAmount);

    if (toDeduct.gt(0) && active.balance.lt(toDeduct)) {
      // decisions.md BD-1 (reversed): NOT a partial deduction. No wallet
      // write, no transaction write. The caller (LifecycleService) logs this
      // as an exceptional invariant violation.
      this.paymentMetrics.commissionDeductionInvariantViolation({ driverId, rideId });
      return {
        outcome: 'INSUFFICIENT_BALANCE',
        commissionAmount: toDeduct,
        actualBalance: active.balance,
      };
    }

    // Insert BEFORE updating the balance: the partial unique index
    // (commission_wallet_one_deduction_per_ride) is the crash-survivable
    // backstop behind FR-021 (constitution §5.4). If a concurrent duplicate
    // somehow raced past the check above, this insert fails with a unique
    // violation and the balance is never touched — the whole `completeRide`
    // transaction rolls back and the caller's retry finds the row the
    // check above was looking for. Swallowing this here instead would risk
    // committing a balance change whose own transaction record didn't survive.
    const transaction = await this.commissionWalletRepository.recordTransaction(
      {
        walletId: wallet.id,
        driverId,
        rideId,
        txnType: 'RIDE_COMMISSION',
        amount: toDeduct.neg(),
        balanceAfter: active.balance.sub(toDeduct),
        referenceType: 'RIDE',
        referenceId: rideId,
        description: `Ride commission for ${rideId}`,
      },
      tx,
    );
    const newBalance = active.balance.sub(toDeduct);
    await this.commissionWalletRepository.updateBalance(wallet.id, newBalance, tx);
    this.paymentMetrics.commissionDeducted({ driverId, rideId });
    return { outcome: 'DEDUCTED', amount: toDeduct, transaction };
  }

  /// Phase 4 (Rev 5 G3): Independent post-completion RIDE_GST_RECOVERY debit.
  /// Guarded by `commission_wallet_one_gst_recovery_per_ride` partial unique index;
  /// never partial, never negative, and completely separate from `RIDE_COMMISSION`.
  async deductGstRecoveryInTx(
    driverId: string,
    rideId: string,
    recoveryAmount: Decimal,
    tx: TransactionClient,
  ): Promise<CommissionDeductionResult> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;

    const existing = await this.commissionWalletRepository.findRideGstRecoveryTransaction(
      rideId,
      tx,
    );
    if (existing) {
      return { outcome: 'ALREADY_PROCESSED' };
    }

    const toDeduct = Decimal.max(0, recoveryAmount);
    if (toDeduct.gt(0) && active.balance.lt(toDeduct)) {
      return {
        outcome: 'INSUFFICIENT_BALANCE',
        commissionAmount: toDeduct,
        actualBalance: active.balance,
      };
    }

    const newBalance = active.balance.sub(toDeduct);
    const transaction = await this.commissionWalletRepository.recordTransaction(
      {
        walletId: wallet.id,
        driverId,
        rideId,
        txnType: 'RIDE_GST_RECOVERY',
        amount: toDeduct.neg(),
        balanceAfter: newBalance,
        referenceType: 'RIDE',
        referenceId: rideId,
        description: `Ride passenger GST recovery for ${rideId}`,
      },
      tx,
    );
    await this.commissionWalletRepository.updateBalance(wallet.id, newBalance, tx);
    return { outcome: 'DEDUCTED', amount: toDeduct, transaction };
  }

  /// Rev 5 §1.6: Admin manual debit enforcing `availableBalance` so active ride reservations
  /// can never be encroached upon (`409 INSUFFICIENT_AVAILABLE_BALANCE_DUE_TO_RESERVATIONS`).
  async adminDebitInTx(
    driverId: string,
    amount: Decimal,
    tx: TransactionClient,
    reference: { referenceId?: string | null; description: string },
  ): Promise<DriverCommissionWalletTransaction> {
    if (amount.lte(0)) {
      throw new Error('Admin debit amount must be greater than zero');
    }
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId, tx);
    const locked = await this.commissionWalletRepository.lockForUpdate(driverId, tx);
    const active = locked ?? wallet;
    const reserved = await this.commissionWalletRepository.sumActiveReservations(driverId, tx);
    const available = active.balance.sub(reserved);
    if (available.lt(amount)) {
      throw new InsufficientAvailableBalanceDueToReservationsError(
        amount.toFixed(2),
        Decimal.max(0, available).toFixed(2),
        reserved.toFixed(2),
      );
    }
    const newBalance = active.balance.sub(amount);
    const txn = await this.commissionWalletRepository.recordTransaction(
      {
        walletId: wallet.id,
        driverId,
        txnType: 'ADMIN_DEBIT',
        amount: amount.neg(),
        balanceAfter: newBalance,
        referenceType: 'ADMIN_ADJUSTMENT',
        referenceId: reference.referenceId ?? null,
        description: reference.description,
      },
      tx,
    );
    await this.commissionWalletRepository.updateBalance(wallet.id, newBalance, tx);
    return txn;
  }
}
