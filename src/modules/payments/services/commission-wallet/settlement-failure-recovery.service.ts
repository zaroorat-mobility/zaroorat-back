import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { recordAdminAction, type AuditActor } from '@modules/admin/audit/index.js';
import { Decimal } from '../../types/index.js';
import { CommissionWalletRepository } from '../../repositories/commission-wallet.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { LEDGER_ACCOUNTS } from '../../constants/payment.constants.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import {
  FailureAlreadyResolvedError,
  InsufficientAvailableBalanceForRecoveryError,
  SettlementFailureNotFoundError,
  StepAlreadyPostedError,
} from '../../errors/payment.errors.js';

export interface FailureRecoveryResult {
  failureId: string;
  rideId: string;
  driverId: string;
  kind: 'COMMISSION' | 'GST_RECOVERY';
  amount: number;
  status: 'RECOVERED';
  walletTxnId: string;
  ledgerGroupId: string;
  resolvedAt: string;
}

/// Phase 4 (Rev 5 §4.5 — Correction R5-6): Atomic Settlement Failure Recovery & Waiver.
/// Locks the open failure row, the ride_settlement_steps row, and the driver's wallet
/// inside a single PostgreSQL ACID transaction so concurrent calls serialize cleanly
/// and any crash before COMMIT rolls back with zero partial state.
export class SettlementFailureRecoveryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly commissionWalletRepository: CommissionWalletRepository,
    private readonly ledgerService: LedgerService,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async listFailures(query: {
    status?: 'OPEN' | 'RECOVERED' | 'WAIVED';
    kind?: 'COMMISSION' | 'GST_RECOVERY';
    driverId?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.driverId ? { driverId: query.driverId } : {}),
    };
    const [totalCount, rows] = await Promise.all([
      this.databaseService.client.commissionCollectionFailure.count({ where }),
      this.databaseService.client.commissionCollectionFailure.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        rideId: r.rideId,
        driverId: r.driverId,
        kind: r.kind,
        amount: Number(r.amount.toString()),
        balanceAtAttempt: Number(r.balanceAtAttempt.toString()),
        status: r.status,
        recoveryWalletTxnId: r.recoveryWalletTxnId,
        recoveryLedgerGroupId: r.recoveryLedgerGroupId,
        waiverReason: r.waiverReason,
        resolvedBy: r.resolvedBy,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: {
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
        pageSize: limit,
        totalCount,
      },
    };
  }

  /// Atomic failure recovery transaction (Rev 5 R5-6).
  /// Optional `beforeCommitHook` exists strictly for deterministic crash-injection testing (T6).
  async recoverFailure(
    failureId: string,
    actor: AuditActor,
    options?: { beforeCommitHook?: (tx: TransactionClient) => Promise<void> },
  ): Promise<FailureRecoveryResult> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      // 1. Lock the failure row FOR UPDATE — concurrent requests serialize right here.
      const lockedFailureRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "commission_collection_failures" WHERE "id" = ${failureId}::uuid FOR UPDATE
      `;
      if (lockedFailureRows.length === 0) {
        throw new SettlementFailureNotFoundError(failureId);
      }
      const failure = await tx.commissionCollectionFailure.findUniqueOrThrow({
        where: { id: failureId },
      });
      if (failure.status !== 'OPEN') {
        throw new FailureAlreadyResolvedError(failure.id, failure.status);
      }

      const kind = failure.kind as 'COMMISSION' | 'GST_RECOVERY';
      const stepType = kind === 'COMMISSION' ? 'COMMISSION_DEBIT' : 'GST_RECOVERY_DEBIT';

      // 2. Lock the matching ride_settlement_steps row FOR UPDATE.
      await tx.$queryRaw`
        SELECT "id" FROM "ride_settlement_steps"
        WHERE "ride_id" = ${failure.rideId}::uuid AND "step_type" = ${stepType}
        FOR UPDATE
      `;
      const step = await tx.rideSettlementStep.findUnique({
        where: { rideId_stepType: { rideId: failure.rideId, stepType } },
      });
      if (step && step.status === 'POSTED') {
        throw new StepAlreadyPostedError(failure.rideId, stepType);
      }

      // 3. Lock driver commission wallet FOR UPDATE and verify availableBalance (respecting active reservations).
      const wallet = await this.commissionWalletRepository.getOrCreateWallet(failure.driverId, tx);
      const lockedWallet = await this.commissionWalletRepository.lockForUpdate(
        failure.driverId,
        tx,
      );
      const activeWallet = lockedWallet ?? wallet;
      const reserved = await this.commissionWalletRepository.sumActiveReservations(
        failure.driverId,
        tx,
      );
      const availableBalance = Decimal.max(0, activeWallet.balance.sub(reserved));
      const amount = failure.amount;

      if (availableBalance.lt(amount)) {
        throw new InsufficientAvailableBalanceForRecoveryError(
          amount.toFixed(2),
          availableBalance.toFixed(2),
        );
      }

      // 4. Post single wallet debit + single balanced ledger group.
      //    - COMMISSION   -> Dr DRIVER_COMMISSION_WALLET / Cr PLATFORM_COMMISSION
      //    - GST_RECOVERY -> Dr DRIVER_COMMISSION_WALLET / Cr DRIVER_GST_RECOVERY_CLEARING (NEVER re-credits TAX_PAYABLE!)
      const newBalance = activeWallet.balance.sub(amount);
      const txnType = kind === 'COMMISSION' ? 'RIDE_COMMISSION' : 'RIDE_GST_RECOVERY';
      const walletTxn = await this.commissionWalletRepository.recordTransaction(
        {
          walletId: activeWallet.id,
          driverId: failure.driverId,
          rideId: failure.rideId,
          txnType,
          amount: amount.neg(),
          balanceAfter: newBalance,
          referenceType: 'COLLECTION_FAILURE',
          referenceId: failure.id,
          description: `Recovered ${kind} failure ${failure.id} for ride ${failure.rideId}`,
        },
        tx,
      );
      await this.commissionWalletRepository.updateBalance(activeWallet.id, newBalance, tx);

      const ledgerGroupId = randomUUID();
      const creditAccount =
        kind === 'COMMISSION'
          ? LEDGER_ACCOUNTS.PLATFORM_COMMISSION
          : LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING;

      await this.ledgerService.postTransactionGroup(
        [
          {
            account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
            accountRefId: failure.driverId,
            direction: 'DEBIT',
            amount,
            referenceType: 'COLLECTION_FAILURE',
            referenceId: failure.id,
            description: `Recovered ${kind} debit for ride ${failure.rideId}`,
          },
          {
            account: creditAccount,
            direction: 'CREDIT',
            amount,
            referenceType: 'COLLECTION_FAILURE',
            referenceId: failure.id,
            description:
              kind === 'COMMISSION'
                ? `Recovered platform commission for ride ${failure.rideId}`
                : `Cleared GST recovery receivable for ride ${failure.rideId}`,
          },
        ],
        tx,
        ledgerGroupId,
      );

      // 5. Atomic state transition on failure & settlement step
      const resolvedAt = new Date();
      const updatedCount = await tx.commissionCollectionFailure.updateMany({
        where: { id: failure.id, status: 'OPEN' },
        data: {
          status: 'RECOVERED',
          recoveryWalletTxnId: walletTxn.id,
          recoveryLedgerGroupId: ledgerGroupId,
          resolvedBy: actor.actorId,
          resolvedAt,
        },
      });
      if (updatedCount.count !== 1) {
        throw new FailureAlreadyResolvedError(failure.id, 'RECOVERED');
      }

      if (step) {
        await tx.rideSettlementStep.update({
          where: { id: step.id },
          data: {
            status: 'POSTED',
            walletTxnId: walletTxn.id,
            ledgerGroupId,
          },
        });
      } else {
        await tx.rideSettlementStep.create({
          data: {
            rideId: failure.rideId,
            stepType,
            status: 'POSTED',
            walletTxnId: walletTxn.id,
            ledgerGroupId,
            amount,
          },
        });
      }

      // 6. Audit & outbox event
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'commission_collection_failure',
        entityId: failure.id,
        summary: `Recovered ${kind} settlement failure (${amount.toFixed(2)} INR) for ride ${failure.rideId}`,
        before: { status: failure.status, amount: amount.toFixed(2) },
        after: {
          status: 'RECOVERED',
          walletTxnId: walletTxn.id,
          ledgerGroupId,
          resolvedAt: resolvedAt.toISOString(),
        },
        result: 'SUCCESS',
      });

      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.SETTLEMENT_FAILURE_RECOVERED, failure.id, {
          failureId: failure.id,
          rideId: failure.rideId,
          driverId: failure.driverId,
          kind,
          amount: amount.toNumber(),
          walletTxnId: walletTxn.id,
          ledgerGroupId,
        }),
        tx,
      );

      if (options?.beforeCommitHook) {
        await options.beforeCommitHook(tx);
      }

      return {
        failureId: failure.id,
        rideId: failure.rideId,
        driverId: failure.driverId,
        kind,
        amount: amount.toNumber(),
        status: 'RECOVERED',
        walletTxnId: walletTxn.id,
        ledgerGroupId,
        resolvedAt: resolvedAt.toISOString(),
      };
    });
  }

  async waiveFailure(failureId: string, reason: string, actor: AuditActor) {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      throw new Error('A waiver reason of at least 3 characters is required');
    }

    return this.databaseService.transactionManager.execute(async (tx) => {
      const lockedRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "commission_collection_failures" WHERE "id" = ${failureId}::uuid FOR UPDATE
      `;
      if (lockedRows.length === 0) {
        throw new SettlementFailureNotFoundError(failureId);
      }
      const failure = await tx.commissionCollectionFailure.findUniqueOrThrow({
        where: { id: failureId },
      });
      if (failure.status !== 'OPEN') {
        throw new FailureAlreadyResolvedError(failure.id, failure.status);
      }

      const stepType =
        failure.kind === 'COMMISSION' ? 'COMMISSION_DEBIT' : 'GST_RECOVERY_DEBIT';
      const resolvedAt = new Date();

      await tx.commissionCollectionFailure.update({
        where: { id: failure.id },
        data: {
          status: 'WAIVED',
          waiverReason: trimmed,
          resolvedBy: actor.actorId,
          resolvedAt,
        },
      });

      await tx.rideSettlementStep.updateMany({
        where: {
          rideId: failure.rideId,
          stepType,
          status: 'FAILED_INSUFFICIENT_BALANCE',
        },
        data: { status: 'WAIVED' },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'commission_collection_failure',
        entityId: failure.id,
        summary: `Waived ${failure.kind} settlement failure for ride ${failure.rideId}: ${trimmed}`,
        before: { status: failure.status },
        after: { status: 'WAIVED', waiverReason: trimmed },
        result: 'SUCCESS',
      });

      return {
        failureId: failure.id,
        rideId: failure.rideId,
        kind: failure.kind,
        status: 'WAIVED' as const,
        waiverReason: trimmed,
        resolvedAt: resolvedAt.toISOString(),
      };
    });
  }
}
