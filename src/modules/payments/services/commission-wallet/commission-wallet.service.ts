import { Decimal } from '../../types/index.js';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { CommissionWalletRepository } from '../../repositories/commission-wallet.repository.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { DriverCommissionWallet, DriverCommissionWalletTransaction } from '../../types';

export type CommissionDeductionResult =
  | { outcome: 'DEDUCTED'; amount: Decimal; transaction: DriverCommissionWalletTransaction }
  | { outcome: 'INSUFFICIENT_BALANCE'; commissionAmount: Decimal; actualBalance: Decimal }
  | { outcome: 'ALREADY_PROCESSED' };

/// spec.md FR-007–FR-024e / decisions.md BD-1/BD-4/BD-7. A commission-model
/// driver's Commission Wallet: a single balance, no locked/reserved portion
/// (no reservation/freeze — BD-4), and exactly two money-affecting operations:
/// recharge (`creditInTx`) and a ride's full, exact, once-only commission
/// deduction (`deductInTx`). There is deliberately no `reserve`/`release`
/// method and no partial-deduction code path anywhere in this class.
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
  ): Promise<DriverCommissionWalletTransaction[]> {
    return this.commissionWalletRepository.listTransactions(driverId, limit);
  }

  /// A plain, read-only comparison — spec.md FR-017a: "MUST NOT reserve, lock,
  /// freeze, or otherwise set aside any part of a commission-model driver's
  /// wallet balance at ride assignment/acceptance time." No lock is taken; no
  /// row is written. Called from `LifecycleService.acceptRideRequest`.
  async hasSufficientBalance(driverId: string, commissionAmount: Decimal): Promise<boolean> {
    const wallet = await this.commissionWalletRepository.getOrCreateWallet(driverId);
    return wallet.balance.gte(commissionAmount);
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
}
