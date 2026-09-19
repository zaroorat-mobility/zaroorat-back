import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { PayoutRepository } from '../../repositories/payout.repository.js';
import { SettlementRepository } from '../../repositories/settlement.repository.js';
import { SettlementWalletRepository } from '../../repositories/settlement-wallet.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import {
  InvalidPayoutAmountError,
  PayoutBankAccountInactiveError,
  PayoutBankAccountInvalidError,
  PayoutBankAccountNotEnabledError,
  PayoutBankAccountNotVerifiedError,
  PayoutExceedsAvailableError,
  PayoutExceedsWalletBalanceError,
  PayoutNotFoundError,
  PayoutNotPendingError,
  PayoutBankSecurityNotReadyError,
  PayoutUnbackedError,
  SettlementNotPayableError,
} from '../../errors/payment.errors.js';
import type { DriverPayout, DriverSettlement } from '../../types';
import { SystemSettingService } from '@modules/admin/system-settings/services/system-setting.service.js';
import { BANK_ENCRYPTION_VERIFIED_SETTING } from '@shared/crypto/bank-account-crypto.js';

/// Written into `DriverPayout.gateway`. Option A performs no provider payout
/// call: finance executes the bank transfer outside this system and records it
/// here. When a real payout rail is integrated, its provider name goes in this
/// column instead and this stops being the only possible value.
const MANUAL_PAYOUT_METHOD = 'MANUAL';

/// A settlement in one of these states is finished with — either every rupee
/// is already paid, or finance abandoned the period.
const NON_PAYABLE_SETTLEMENT_STATUSES: readonly string[] = ['PAID', 'FAILED'];

/// Driver payouts, Option A: recorded and confirmed by finance, never sent to
/// a payment provider.
///
/// The lifecycle is deliberately two-phase, and the split is the whole point:
///
///   initiate → `DriverPayout(INITIATED)`, committed. Reserves the amount
///              against the settlement. **No money has moved.**
///   confirm  → finance supplies the bank's own reference for a transfer that
///              already executed. THIS is where the driver wallet is debited,
///              the `DRIVER_PAYABLE` ledger debit is posted, and the
///              settlement may finally reach `PAID`.
///   fail     → the attempt did not move money. The row stays, with a reason.
///
/// **Lock order.** Every path here takes row locks in ONE order:
///
///   DriverPayout → DriverSettlement → DriverWallet
///
/// Initiation starts at the settlement (it has no existing payout to lock),
/// confirmation and failure start at the payout. A path may skip a level but
/// never go backwards. Confirmation used to lock payout → wallet → settlement
/// while initiation locked settlement → wallet; the two could deadlock.
///
/// **Availability.** `availableBalance = balance − lockedBalance`. An
/// INITIATED payout holds its amount in `lockedBalance`, so the same money can
/// never be promised to two payouts — across settlements, and across payout
/// rails, since every rail reserves on this one wallet row.
///
/// The previous single-phase version opened a database transaction, made a
/// live 15-second gateway call inside it, and marked the settlement `PAID` if
/// that call merely did not throw. It also wrote `FAILED` and then rethrew
/// from inside the same transaction, so every failed payout was rolled
/// straight back out of existence. Both are gone.
export class PayoutService {
  constructor(
    private readonly payoutRepo: PayoutRepository,
    private readonly settlementRepo: SettlementRepository,
    private readonly settlementWalletRepo: SettlementWalletRepository,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
    private readonly systemSettingService: SystemSettingService,
  ) {}

  /// Phase 1. Validates every precondition, reserves the amount, and records
  /// the intent to pay. Moves nothing.
  async executePayout(data: {
    driverId: string;
    settlementId?: string;
    bankAccountId: string;
    amount: Decimal;
    idempotencyKey: string;
  }): Promise<DriverPayout> {
    if (!data.amount.isFinite() || data.amount.lte(0)) {
      throw new InvalidPayoutAmountError();
    }
    const existing = await this.payoutRepo.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return existing;
    if (!data.settlementId) throw new PayoutUnbackedError();

    try {
      return await this.txManager.execute(async (tx) => {
        const settlement = await this.settlementRepo.lockForUpdate(data.settlementId as string, tx);
        if (!settlement) throw new PayoutUnbackedError('Settlement not found');
        if (settlement.driverId !== data.driverId) {
          throw new PayoutUnbackedError('Settlement does not belong to this driver');
        }
        if (NON_PAYABLE_SETTLEMENT_STATUSES.includes(settlement.status)) {
          throw new SettlementNotPayableError(settlement.status);
        }

        await this.assertPayableBankAccount(data.driverId, data.bankAccountId, tx);

        // An INITIATED payout holds its amount: `sumCommittedForSettlement`
        // counts everything not FAILED, so a reservation blocks a second
        // payout of the same rupees even before it is confirmed.
        const committed = await this.payoutRepo.sumCommittedForSettlement(settlement.id, tx);
        const available = settlement.netPayable.sub(committed);
        if (data.amount.gt(available)) {
          throw new PayoutExceedsAvailableError(data.amount.toString(), available.toString());
        }

        // Settlement locked above, wallet now: the lock order. The reservation
        // is checked and taken under the wallet row lock, so a concurrent
        // payout for this driver waits here and then sees this one's hold.
        const wallet = await this.settlementWalletRepo.lockForUpdate(data.driverId, tx);
        const availableBalance = wallet ? wallet.balance.sub(wallet.lockedBalance) : new Decimal(0);
        if (data.amount.gt(availableBalance)) {
          throw new PayoutExceedsWalletBalanceError(
            data.amount.toString(),
            availableBalance.toString(),
          );
        }
        await this.settlementWalletRepo.reserve(data.driverId, data.amount, tx);

        const payoutRecord = await this.payoutRepo.createPayout(
          {
            driverId: data.driverId,
            settlementId: settlement.id,
            bankAccountId: data.bankAccountId,
            amount: data.amount,
            idempotencyKey: data.idempotencyKey,
            gateway: MANUAL_PAYOUT_METHOD,
          },
          tx,
        );
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.PAYOUT_INITIATED, data.driverId, {
            payoutId: payoutRecord.id,
            settlementId: settlement.id,
            amount: data.amount.toNumber(),
          }),
          tx,
        );
        return payoutRecord;
      });
    } catch (err) {
      if (isDuplicateIdempotencyKey(err)) {
        const winner = await this.payoutRepo.findByIdempotencyKey(data.idempotencyKey);
        if (winner) return winner;
      }
      throw err;
    }
  }

  /// Phase 2a. Finance confirms that a bank transfer for this payout actually
  /// executed, quoting the bank's reference. This is the ONE place in the
  /// codebase where a driver's money is recognised as having left the
  /// platform.
  async confirmPayout(data: {
    payoutId: string;
    externalReference: string;
  }): Promise<DriverPayout> {
    return this.txManager.execute(async (tx) => {
      const payout = await this.payoutRepo.lockForUpdate(data.payoutId, tx);
      if (!payout) throw new PayoutNotFoundError();
      // INITIATED → COMPLETED under a row lock is what makes the wallet debit
      // below exactly-once: a concurrent or repeated confirmation finds the
      // row already COMPLETED and is refused, never debiting twice.
      if (payout.status !== 'INITIATED') throw new PayoutNotPendingError(payout.status);

      // Lock order: payout (above) → settlement → wallet.
      const settlement = payout.settlementId
        ? await this.settlementRepo.lockForUpdate(payout.settlementId, tx)
        : null;
      const wallet = await this.settlementWalletRepo.lockForUpdate(payout.driverId, tx);

      // This payout's own amount is already held, so the question here is
      // only whether spending it would overdraw the wallet — which a cash-ride
      // clawback since initiation can make true. It is never allowed to.
      const balance = wallet?.balance ?? new Decimal(0);
      if (payout.amount.gt(balance)) {
        throw new PayoutExceedsWalletBalanceError(payout.amount.toString(), balance.toString());
      }
      await this.settlementWalletRepo.withdrawReserved(
        {
          driverId: payout.driverId,
          amount: payout.amount,
          referenceType: 'PAYOUT',
          referenceId: payout.id,
          description: `Bank transfer to driver ${payout.driverId} (ref ${data.externalReference})`,
        },
        tx,
      );

      const updated = await this.payoutRepo.markCompleted(payout.id, data.externalReference, tx);

      // `DRIVER_PAYABLE` was credited when the ride was collected; this
      // relieves it. `BANK_CLEARING` — not `GATEWAY_CLEARING` — because the
      // money left the platform's own bank account by manual transfer and
      // never passed through a payment gateway.
      await this.ledgerService.postTransactionGroup(
        [
          {
            account: 'DRIVER_PAYABLE',
            accountRefId: payout.driverId,
            direction: 'DEBIT',
            amount: payout.amount,
            referenceType: 'PAYOUT',
            referenceId: payout.id,
            description: `Manual bank payout to driver ${payout.driverId}`,
          },
          {
            account: 'BANK_CLEARING',
            direction: 'CREDIT',
            amount: payout.amount,
            referenceType: 'PAYOUT',
            referenceId: payout.id,
            description: `Manual bank payout reference ${data.externalReference}`,
          },
        ],
        tx,
      );

      if (settlement) {
        await this.markSettlementPaidIfCovered(settlement, tx);
      }

      this.paymentMetrics.payoutSuccess({ payoutId: payout.id });
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.PAYOUT_COMPLETED, payout.driverId, {
          payoutId: payout.id,
          amount: payout.amount.toNumber(),
          externalReference: data.externalReference,
        }),
        tx,
      );
      return updated;
    });
  }

  /// Phase 2b. The transfer did not happen. The row is kept and marked FAILED
  /// with a reason — never deleted, never rolled back — so a failed attempt
  /// stays auditable. Its wallet reservation is released and, being FAILED, it
  /// drops out of `sumCommittedForSettlement` too.
  async failPayout(data: { payoutId: string; reason: string }): Promise<DriverPayout> {
    return this.txManager.execute(async (tx) => {
      const payout = await this.payoutRepo.lockForUpdate(data.payoutId, tx);
      if (!payout) throw new PayoutNotFoundError();
      if (payout.status !== 'INITIATED') throw new PayoutNotPendingError(payout.status);

      // Lock order: payout (above) → wallet. The settlement needs no write, so
      // it is skipped — skipping a level is fine, going backwards is not.
      await this.settlementWalletRepo.lockForUpdate(payout.driverId, tx);
      await this.settlementWalletRepo.release(payout.driverId, payout.amount, tx);

      const updated = await this.payoutRepo.markFailed(payout.id, data.reason, tx);
      this.paymentMetrics.payoutFailure({ payoutId: payout.id });
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.PAYOUT_FAILED, payout.driverId, {
          payoutId: payout.id,
          amount: payout.amount.toNumber(),
          reason: data.reason,
        }),
        tx,
      );
      return updated;
    });
  }

  /// The bank account must exist, be this driver's, be VERIFIED, and be
  /// explicitly payout-enabled. `payoutEnabled` was a column nothing ever read
  /// — this is the check it exists for.
  private async assertPayableBankAccount(
    driverId: string,
    bankAccountId: string,
    tx: TransactionClient,
  ): Promise<void> {
    const account = await tx.driverBankAccount.findUnique({ where: { id: bankAccountId } });
    if (!account || account.driverId !== driverId) {
      throw new PayoutBankAccountInvalidError();
    }
    if (!account.isActive) {
      throw new PayoutBankAccountInactiveError();
    }
    // `status` is the audited lifecycle; `verificationStatus` is kept in step
    // for older readers. Both must agree the account was verified.
    if (
      account.verificationStatus !== 'VERIFIED' ||
      (account.status !== 'VERIFIED' && account.status !== 'PAYOUT_ENABLED')
    ) {
      throw new PayoutBankAccountNotVerifiedError(account.status);
    }
    if (!account.payoutEnabled || account.status !== 'PAYOUT_ENABLED') {
      throw new PayoutBankAccountNotEnabledError();
    }
    // Security prerequisites: this account's number is held encrypted, and the
    // encryption backfill has been verified across every account.
    if (
      !account.accountNumberCiphertext ||
      !(await this.systemSettingService.getSettingValue(BANK_ENCRYPTION_VERIFIED_SETTING, tx))
    ) {
      throw new PayoutBankSecurityNotReadyError();
    }
  }

  /// `PAID` is written here and nowhere else, and only once COMPLETED payouts
  /// cover the whole `netPayable`. A partially paid settlement stays where it
  /// is. An INITIATED payout does not count — reserving money is not paying it.
  /// Takes the settlement row the caller ALREADY locked — re-locking it here,
  /// after the wallet, is exactly the backwards step the lock order forbids.
  private async markSettlementPaidIfCovered(
    settlement: DriverSettlement,
    tx: TransactionClient,
  ): Promise<void> {
    if (settlement.status === 'PAID') return;
    const paid = await this.payoutRepo.sumCompletedForSettlement(settlement.id, tx);
    if (paid.gte(settlement.netPayable)) {
      await this.settlementRepo.updateStatus(settlement.id, 'PAID', tx);
    }
  }
}

function isDuplicateIdempotencyKey(err: unknown): boolean {
  const code = (
    err as {
      code?: unknown;
    }
  )?.code;
  const target = (
    err as {
      meta?: {
        target?: unknown;
      };
    }
  )?.meta?.target;
  const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  if (code === 'P2002') return targetText === '' || /idempotency/i.test(targetText);
  return (
    /unique constraint failed/i.test((err as Error)?.message ?? '') &&
    /idempotency/i.test((err as Error)?.message ?? '')
  );
}
