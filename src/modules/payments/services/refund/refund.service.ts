import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import {
  RefundRepository,
  type RefundableTransaction,
} from '../../repositories/refund.repository.js';
import type { LedgerItemInput } from '../../repositories/ledger.repository.js';
import { PaymentGatewayResolverService } from '../gateway/payment-gateway-resolver.service.js';
import type { GatewayRefundResult } from '../gateway/gateway.provider.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { CommissionWalletService } from '../commission-wallet/commission-wallet.service.js';
import {
  InsufficientBalanceError,
  RefundBalanceUnavailableError,
  RefundNotAllowedError,
} from '../../errors/payment.errors.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { Refund } from '../../types';

/// The only payments that can be refunded, and each reverses its OWN original
/// collection — never another purpose's accounts:
///   CUSTOMER_WALLET_TOPUP        GATEWAY_CLEARING DR / CUSTOMER_WALLET CR
///   DRIVER_COMMISSION_RECHARGE   GATEWAY_CLEARING DR / DRIVER_COMMISSION_WALLET CR
///   DRIVER_SUBSCRIPTION_PAYMENT  GATEWAY_CLEARING DR / SUBSCRIPTION_REVENUE CR
export const REFUNDABLE_PURPOSES = [
  'CUSTOMER_WALLET_TOPUP',
  'DRIVER_COMMISSION_RECHARGE',
  'DRIVER_SUBSCRIPTION_PAYMENT',
] as const;
type RefundablePurpose = (typeof REFUNDABLE_PURPOSES)[number];

/// Who is asking, beyond ownership. SUPPORT may refund a customer's own wallet
/// top-up on their behalf. Only FINANCE (finance, admin, system_admin) may
/// refund driver money: a subscription or a commission recharge decides whether
/// a driver can work, so it is never self-service.
export type RefundStaffScope = 'NONE' | 'SUPPORT' | 'FINANCE';

const CAPTURED_TXN_TYPES = ['PAYMENT', 'CHARGE'];
const DISPATCH_LEASE_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;

type ProviderOutcome =
  | { kind: 'RESOLVED'; result: GatewayRefundResult }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'UNKNOWN'; reason: string };

/// Refund lifecycle (Phase 1).
///
///   PENDING ──reserve──▶ PROCESSING ──provider confirms──▶ SUCCEEDED
///                            │  └─provider refuses──────▶ FAILED (reservation undone)
///                            └─timeout / 5xx / DB loss: stays PROCESSING,
///                              resolved by reconciliation with the SAME reference
///
/// Reserve first, provider second. The refunded amount is taken out of the
/// balance it came from (customer wallet, commission credit) — or out of
/// subscription revenue — into REFUND_IN_TRANSIT before the provider is asked,
/// so the money cannot be spent while the refund is in flight. Confirmation
/// clears REFUND_IN_TRANSIT to GATEWAY_CLEARING, which nets to exactly the
/// reversal of the original collection.
///
/// The provider is always addressed by its OWN payment id
/// (`PaymentTransaction.gatewayTxnId`), and our Refund.id is the reference it
/// is created under, so a retry finds the refund instead of creating another.
export class RefundService {
  constructor(
    private readonly refundRepo: RefundRepository,
    private readonly gatewayResolver: PaymentGatewayResolverService,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
    private readonly walletService: WalletService,
    private readonly commissionWalletService: CommissionWalletService,
    private readonly driverRepository: DriverRepository,
  ) {}

  /// `POST /payments/refunds`. Validation, the refund row and the reservation
  /// commit together — a refused request leaves nothing behind — and only
  /// then is the provider asked.
  async processRefund(data: {
    transactionId: string;
    userId: string;
    amount: Decimal;
    reason?: string;
    idempotencyKey: string;
    staffScope?: RefundStaffScope;
  }): Promise<Refund> {
    if (!data.amount.isFinite() || data.amount.lte(0)) {
      throw new RefundNotAllowedError('Refund amount must be strictly greater than zero');
    }
    const existing = await this.refundRepo.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return this.continueExisting(existing);

    let reserved: Refund;
    try {
      reserved = await this.txManager.execute(async (tx) => {
        const txn = await this.refundRepo.lockTransaction(data.transactionId, tx);
        // Missing and not-yours are one answer, so transaction ids cannot be probed.
        if (!txn || !this.mayRefund(txn, data.userId, data.staffScope ?? 'NONE')) {
          throw new RefundNotAllowedError('This transaction cannot be refunded');
        }
        const purpose = await this.assertRefundable(txn, data.amount, tx);
        const refund = await this.refundRepo.create(
          {
            transactionId: txn.id,
            rideId: txn.rideId,
            // Always the payer — never the staff member asking.
            userId: txn.userId,
            amount: data.amount,
            reason: data.reason ?? null,
            idempotencyKey: data.idempotencyKey,
            purpose,
          },
          tx,
        );
        return this.reserveInTx(refund, txn, purpose, tx);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await this.refundRepo.findByIdempotencyKey(data.idempotencyKey);
        if (winner) return this.continueExisting(winner);
      }
      throw err;
    }
    return this.sendToProvider(reserved);
  }

  /// Admin-reviewed refunds: reserve if still PENDING, then ask the provider.
  /// Kept under this name because the admin finance workflow calls it.
  async processPendingRefund(refundId: string): Promise<Refund> {
    return this.dispatch(refundId);
  }

  async dispatch(refundId: string): Promise<Refund> {
    const refund = await this.txManager.execute(async (tx) => {
      const row = await this.refundRepo.lockForUpdate(refundId, tx);
      if (!row) throw new RefundNotAllowedError('Refund was not found');
      if (row.status !== 'PENDING') return row;
      const txn = await this.refundRepo.lockTransaction(row.transactionId, tx);
      if (!txn) throw new RefundNotAllowedError('This transaction cannot be refunded');
      const purpose = await this.assertRefundable(txn, row.amount, tx, row.id);
      return this.reserveInTx(row, txn, purpose, tx);
    });
    if (refund.status !== 'PROCESSING') return refund;
    return this.sendToProvider(refund);
  }

  /// Backstop for unknown outcomes: a refund left PROCESSING by a timeout, a
  /// provider 5xx, or a database failure after the provider accepted it.
  async reconcileStale(
    now: Date = new Date(),
    limit = 100,
  ): Promise<{ scanned: number; resolved: number; stillProcessing: number }> {
    const rows = await this.refundRepo.findStaleProcessing(
      new Date(now.getTime() - STALE_AFTER_MS),
      limit,
    );
    let resolved = 0;
    for (const row of rows) {
      const after = await this.sendToProvider(row, now);
      if (after.status !== 'PROCESSING') resolved++;
    }
    return { scanned: rows.length, resolved, stillProcessing: rows.length - resolved };
  }

  private async continueExisting(refund: Refund): Promise<Refund> {
    if (refund.status === 'PENDING' || refund.status === 'PROCESSING') {
      return this.dispatch(refund.id);
    }
    return refund;
  }

  private mayRefund(txn: RefundableTransaction, userId: string, scope: RefundStaffScope): boolean {
    if (scope === 'FINANCE') return true;
    if (txn.purpose !== 'CUSTOMER_WALLET_TOPUP') return false;
    return txn.userId === userId || scope === 'SUPPORT';
  }

  /// Everything a refund needs to be allowed at all. Throws before any money moves.
  private async assertRefundable(
    txn: RefundableTransaction,
    amount: Decimal,
    tx: TransactionClient,
    excludeRefundId?: string,
  ): Promise<RefundablePurpose> {
    if (txn.status !== 'SUCCEEDED' || !CAPTURED_TXN_TYPES.includes(txn.txnType)) {
      throw new RefundNotAllowedError('Only a captured payment can be refunded');
    }
    // A customer's ride fare is paid to the driver directly and is never a
    // gateway transaction; a ride-linked row is legacy data this path must not touch.
    if (txn.rideId != null) {
      throw new RefundNotAllowedError('A ride payment cannot be refunded through this path');
    }
    if (!(REFUNDABLE_PURPOSES as readonly string[]).includes(txn.purpose)) {
      throw new RefundNotAllowedError('Payments of this kind cannot be refunded');
    }
    const purpose = txn.purpose as RefundablePurpose;
    if (!isRefundableProviderReference(txn.gateway, txn.gatewayTxnId)) {
      throw new RefundNotAllowedError(
        'This payment has no provider payment reference, so the provider cannot be asked to refund it',
      );
    }
    const committed = await this.refundRepo.getCommittedForTransaction(txn.id, tx, excludeRefundId);
    const remaining = txn.amount.sub(committed);
    if (amount.gt(remaining)) {
      this.paymentMetrics.refundFailure({ transactionId: txn.id });
      throw new RefundNotAllowedError(
        `Refund amount (${amount}) exceeds remaining captured amount (${remaining})`,
      );
    }
    if (
      purpose === 'DRIVER_SUBSCRIPTION_PAYMENT' &&
      (!amount.equals(txn.amount) || committed.gt(0))
    ) {
      throw new RefundNotAllowedError('A subscription payment can only be refunded in full');
    }
    return purpose;
  }

  /// PENDING → PROCESSING: takes the refunded amount out of the balance it came
  /// from, against REFUND_IN_TRANSIT, under the refund row lock.
  private async reserveInTx(
    refund: Refund,
    txn: RefundableTransaction,
    purpose: RefundablePurpose,
    tx: TransactionClient,
  ): Promise<Refund> {
    const amount = refund.amount;
    const ref = { referenceType: 'REFUND', referenceId: refund.id };
    let source: LedgerItemInput;
    if (purpose === 'CUSTOMER_WALLET_TOPUP') {
      try {
        await this.walletService.debitInTx(txn.userId, amount, tx, {
          ...ref,
          description: `Refund ${refund.id} reserved`,
        });
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          throw new RefundBalanceUnavailableError(amount.toFixed(2));
        }
        throw err;
      }
      source = {
        account: 'CUSTOMER_WALLET',
        accountRefId: txn.userId,
        direction: 'DEBIT',
        amount,
        ...ref,
      };
    } else if (purpose === 'DRIVER_COMMISSION_RECHARGE') {
      const driverId = await this.payerDriverId(txn, tx);
      await this.commissionWalletService.debitForRefundInTx(driverId, amount, tx, {
        referenceId: refund.id,
        description: `Refund ${refund.id} reserved`,
      });
      source = {
        account: 'DRIVER_COMMISSION_WALLET',
        accountRefId: driverId,
        direction: 'DEBIT',
        amount,
        ...ref,
      };
    } else {
      source = { account: 'SUBSCRIPTION_REVENUE', direction: 'DEBIT', amount, ...ref };
    }
    await this.ledgerService.postTransactionGroup(
      [
        { ...source, description: `Refund ${refund.id} reserved` },
        {
          account: 'REFUND_IN_TRANSIT',
          direction: 'CREDIT',
          amount,
          ...ref,
          description: `Refund ${refund.id} awaiting provider`,
        },
      ],
      tx,
    );
    return this.refundRepo.markProcessing(
      refund.id,
      { purpose, providerPaymentId: txn.gatewayTxnId as string, reservedAt: new Date() },
      tx,
    );
  }

  /// `now` is the caller's clock: the reconciliation job passes its own, so a
  /// scheduled run judges the dispatch lease by the time it was scheduled for.
  private async sendToProvider(refund: Refund, now: Date = new Date()): Promise<Refund> {
    if (!(await this.refundRepo.claimDispatch(refund.id, now, DISPATCH_LEASE_MS))) {
      // Someone else is talking to the provider about this refund right now.
      return (await this.refundRepo.findById(refund.id)) ?? refund;
    }
    const outcome = await this.askProvider(refund);
    try {
      return await this.applyOutcome(refund.id, outcome);
    } catch (err) {
      // The provider may have refunded and we failed to record it. The row is
      // still PROCESSING with its reference, so reconciliation will find the
      // provider's refund and finish the job — never refund twice.
      logger.error({ err, refundId: refund.id }, '[payments] refund outcome could not be recorded');
      return (await this.refundRepo.findById(refund.id)) ?? refund;
    }
  }

  /// Find-before-create with our Refund.id as the reference: a refund the
  /// provider already has is picked up rather than created again. A lookup
  /// that fails is UNKNOWN, and nothing is created on the strength of it.
  private async askProvider(refund: Refund): Promise<ProviderOutcome> {
    try {
      const txn = await this.refundRepo.findRefundableTransaction(refund.transactionId);
      const provider = await this.gatewayResolver.forProviderName(
        (txn?.gateway ?? 'mock') as Parameters<PaymentGatewayResolverService['forProviderName']>[0],
      );
      const providerPaymentId = refund.providerPaymentId as string;
      const found = await provider.findRefund(providerPaymentId, refund.id);
      if (found) return { kind: 'RESOLVED', result: found };
      const created = await provider.createRefund({
        providerPaymentId,
        amount: refund.amount,
        refundReference: refund.id,
      });
      return { kind: 'RESOLVED', result: created };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return isDefinitiveRejection(err)
        ? { kind: 'REJECTED', reason }
        : { kind: 'UNKNOWN', reason };
    }
  }

  private async applyOutcome(refundId: string, outcome: ProviderOutcome): Promise<Refund> {
    return this.txManager.execute(async (tx) => {
      const row = await this.refundRepo.lockForUpdate(refundId, tx);
      if (!row || row.status !== 'PROCESSING') return row as Refund;
      if (outcome.kind === 'UNKNOWN') {
        return this.refundRepo.recordDispatchError(row.id, outcome.reason, tx);
      }
      if (outcome.kind === 'RESOLVED' && outcome.result.status === 'PENDING') {
        return this.refundRepo.setGatewayRefundId(row.id, outcome.result.gatewayRefundId, tx);
      }
      const txn = await this.refundRepo.findRefundableTransaction(row.transactionId, tx);
      if (!txn) throw new Error(`Refund ${row.id} lost its payment transaction`);
      if (outcome.kind === 'RESOLVED' && outcome.result.status === 'SUCCEEDED') {
        return this.settleInTx(row, txn, outcome.result.gatewayRefundId, tx);
      }
      const reason =
        outcome.kind === 'REJECTED' ? outcome.reason : 'The provider reported the refund as failed';
      return this.failInTx(row, txn, reason, tx);
    });
  }

  private async settleInTx(
    row: Refund,
    txn: RefundableTransaction,
    gatewayRefundId: string,
    tx: TransactionClient,
  ): Promise<Refund> {
    const ref = { referenceType: 'REFUND', referenceId: row.id };
    await this.ledgerService.postTransactionGroup(
      [
        {
          account: 'REFUND_IN_TRANSIT',
          direction: 'DEBIT',
          amount: row.amount,
          ...ref,
          description: `Refund ${row.id} confirmed by provider`,
        },
        {
          account: 'GATEWAY_CLEARING',
          direction: 'CREDIT',
          amount: row.amount,
          ...ref,
          description: `Provider refund ${gatewayRefundId}`,
        },
      ],
      tx,
    );
    const updated = await this.refundRepo.markSucceeded(row.id, gatewayRefundId, tx);
    this.paymentMetrics.refundProcessed({ refundId: row.id });
    await this.eventPublisher.publish(
      paymentEvent(PAYMENT_EVENT_CATALOG.REFUND_PROCESSED, txn.userId, {
        refundId: row.id,
        transactionId: txn.id,
        paymentIntentId: txn.intentId,
        purpose: row.purpose,
        userId: txn.userId,
        amount: row.amount.toNumber(),
      }),
      tx,
    );
    return updated;
  }

  /// Undoes the reservation exactly: the balance goes back, and
  /// REFUND_IN_TRANSIT is cleared back into the account it came from.
  private async failInTx(
    row: Refund,
    txn: RefundableTransaction,
    reason: string,
    tx: TransactionClient,
  ): Promise<Refund> {
    const amount = row.amount;
    const ref = { referenceType: 'REFUND', referenceId: row.id };
    let destination: LedgerItemInput;
    if (row.purpose === 'CUSTOMER_WALLET_TOPUP') {
      await this.walletService.creditInTx(txn.userId, amount, tx, {
        ...ref,
        txnType: 'REFUND_REVERSAL',
        description: `Refund ${row.id} refused by provider; balance restored`,
      });
      destination = {
        account: 'CUSTOMER_WALLET',
        accountRefId: txn.userId,
        direction: 'CREDIT',
        amount,
        ...ref,
      };
    } else if (row.purpose === 'DRIVER_COMMISSION_RECHARGE') {
      const driverId = await this.payerDriverId(txn, tx);
      await this.commissionWalletService.restoreRefundedCreditInTx(driverId, amount, tx, {
        referenceId: row.id,
        description: `Refund ${row.id} refused by provider; credit restored`,
      });
      destination = {
        account: 'DRIVER_COMMISSION_WALLET',
        accountRefId: driverId,
        direction: 'CREDIT',
        amount,
        ...ref,
      };
    } else {
      destination = { account: 'SUBSCRIPTION_REVENUE', direction: 'CREDIT', amount, ...ref };
    }
    await this.ledgerService.postTransactionGroup(
      [
        {
          account: 'REFUND_IN_TRANSIT',
          direction: 'DEBIT',
          amount,
          ...ref,
          description: `Refund ${row.id} refused by provider`,
        },
        { ...destination, description: `Refund ${row.id} reservation undone` },
      ],
      tx,
    );
    const updated = await this.refundRepo.markFailed(row.id, reason, tx);
    this.paymentMetrics.refundFailure({ transactionId: txn.id });
    await this.eventPublisher.publish(
      paymentEvent(PAYMENT_EVENT_CATALOG.REFUND_FAILED, txn.userId, {
        refundId: row.id,
        transactionId: txn.id,
        purpose: row.purpose,
        reason,
      }),
      tx,
    );
    return updated;
  }

  /// The driver whose commission credit a recharge funded — resolved from the
  /// payer exactly as the recharge credit was, never from the caller.
  private async payerDriverId(txn: RefundableTransaction, tx: TransactionClient): Promise<string> {
    const driver = await this.driverRepository.findByUserId(txn.userId, tx);
    if (!driver)
      throw new RefundNotAllowedError('This commission recharge has no driver to reverse');
    return driver.id;
  }
}

/// The provider's own payment id, in the shape that provider issues. Our
/// internal UUIDs never pass; nor does a Razorpay ORDER id (`order_…`), which
/// `gatewayTxnId` falls back to when a webhook carried no payment id.
function isRefundableProviderReference(gateway: string | null, ref: string | null): boolean {
  if (!ref) return false;
  if (gateway === 'razorpay') return ref.startsWith('pay_');
  if (gateway === 'stripe') return ref.startsWith('ch_') || ref.startsWith('pi_');
  return gateway === 'mock';
}

/// A 4xx the provider will give again on retry — the refund is refused. A
/// timeout, 408/409/425/429, a 5xx or a network error is NOT: the outcome is
/// unknown and the refund stays PROCESSING for reconciliation.
function isDefinitiveRejection(err: unknown): boolean {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  );
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2002') return true;
  return /unique constraint failed/i.test((err as Error)?.message ?? '');
}
