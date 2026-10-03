import { Decimal } from '../../types/index.js';
import { TransactionManager, UniqueConstraintError } from '@core/database';
import { EventPublisher } from '@core/events';
import { logger } from '@shared/logger/index.js';
import { recordAdminAction, type AuditActor } from '@modules/admin/audit/index.js';
import { SettlementRepository } from '../../repositories/settlement.repository.js';
import { SettlementWalletRepository } from '../../repositories/settlement-wallet.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import type { DriverSettlement } from '../../types';
export class SettlementService {
  constructor(
    private readonly settlementRepo: SettlementRepository,
    private readonly settlementWalletRepo: SettlementWalletRepository,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}
  /// `actor` is set when finance triggers the run: the settlement row, the wallet credit
  /// and the audit row then commit together, so a credit can never exist without the
  /// record of who caused it. The scheduled job passes none — a system calculation, not
  /// an admin action.
  async calculateSettlement(
    data: {
      driverId: string;
      periodStart: Date;
      periodEnd: Date;
      adjustments?: Decimal;
    },
    actor?: AuditActor,
  ): Promise<DriverSettlement> {
    const existing = await this.settlementRepo.findByDriverAndPeriod(
      data.driverId,
      data.periodStart,
      data.periodEnd,
    );
    if (existing) return existing;
    const earned = await this.settlementRepo.aggregateEarnings(
      data.driverId,
      data.periodStart,
      data.periodEnd,
    );
    const grossEarnings = earned.collectedFare;
    // Commission a confirmed cash ride already took out of the driver's wallet
    // (BD-5). Netting it here too would recover the same rupees twice; with
    // the flag off nothing qualifies and this is zero.
    const alreadyRecovered = await this.settlementRepo.alreadyRecoveredCommission(
      data.driverId,
      data.periodStart,
      data.periodEnd,
    );
    const stillOwedOnCash = Decimal.max(0, earned.owedOnCash.sub(alreadyRecovered.recovered));
    /// The commission-labelled slice of `stillOwedOnCash` — nonzero only for
    /// a legacy, no-payment-model ride. A payment-model ride's cash debt is
    /// tax + fee (it still reduces `netPayable` below), never commission, so
    /// it must not inflate the `commission` figure the settlement records.

    /// What this settlement is actually netting: the platform's commission on
    /// the rides it collected, plus anything still owed on cash rides that has
    /// not already come out of the driver's wallet at confirmation time. A cash
    /// debt already recovered contributes nothing — netting it here too would
    /// recover the same rupees twice.

    /// FR-006. `netPayable` used to be `collectedFare - commission`, which was
    /// only ever right because commission was levied on the whole total and so
    /// absorbed the tax and the platform fee. Now that the driver is paid out of
    /// ride revenue alone, `collectedFare - commission` overpays them by exactly
    /// the tax and the fee on every non-cash ride.
    ///
    /// The two sides are stated directly instead: what the platform owes for
    /// rides it collected, less what the driver owes for rides they took cash
    /// on, less anything already recovered from their wallet at confirmation
    /// time so the same rupees are not clawed back twice.
    // A period that ended owing carries into the next one and is deducted
    // before anything is payable (FR-020/FR-021). `adjustments` was a
    // parameter nothing ever supplied; an explicit value still wins, so a
    // finance correction can override the carry.
    const carried = Decimal.min(0, await this.settlementRepo.cumulativeNetPayable(data.driverId));
    const adjustments = data.adjustments ?? carried;
    const stillOwedCommissionOnCash = Decimal.max(
      0,
      earned.commissionOwedOnCash.sub(alreadyRecovered.commissionRecovered),
    );
    const commission = earned.commissionOnCollected.add(stillOwedCommissionOnCash);
    const netPayable = earned.earnedOnCollected.sub(stillOwedOnCash).add(adjustments);
    try {
      return await this.txManager.execute(async (tx) => {
        const settlement = await this.settlementRepo.create(
          {
            driverId: data.driverId,
            periodStart: data.periodStart,
            periodEnd: data.periodEnd,
            grossEarnings,
            commission,
            adjustments,
            netPayable,
          },
          tx,
        );
        // A driver who ran cash-only rides can legitimately net negative here —
        // they owe back the tax and platform fee they collected in cash (and,
        // for a legacy no-payment-model ride only, commission too — see
        // `aggregateEarnings`) — there is nothing to credit, and crediting a
        // negative amount isn't a wallet debit this flow is meant to perform,
        // so only positive payouts move money. The settlement row itself is
        // still written either way, as the period's record of account.
        if (netPayable.gt(0)) {
          await this.settlementWalletRepo.credit(
            {
              driverId: data.driverId,
              amount: netPayable,
              referenceType: 'SETTLEMENT',
              referenceId: settlement.id,
              description: `Settlement payout for ${data.periodStart.toISOString().slice(0, 10)} to ${data.periodEnd.toISOString().slice(0, 10)}`,
            },
            tx,
          );
        }
        /// The settlement STAYS `PENDING` here.
        ///
        /// This used to write `PAID` in the very transaction that created the
        /// row — before any payout existed, before any money moved. `PAID` now
        /// means one thing only: a COMPLETED `DriverPayout` covers the whole
        /// `netPayable`, which only `PayoutService.confirmPayout` can establish.
        /// Calculating what a driver is owed is not paying them.
        ///
        /// The event name is unchanged (consumers depend on it) but it marks the
        /// completion of the CALCULATION, not of a payment.
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.SETTLEMENT_COMPLETED, data.driverId, {
            settlementId: settlement.id,
            driverId: data.driverId,
            netPayable: netPayable.toNumber(),
          }),
          tx,
        );
        if (actor) {
          await recordAdminAction(tx, {
            ...actor,
            action: 'CREATE',
            entityType: 'driver_settlement',
            entityId: settlement.id,
            summary: `Settlement calculated for ${data.periodStart.toISOString().slice(0, 10)} to ${data.periodEnd.toISOString().slice(0, 10)}`,
            after: {
              driverId: data.driverId,
              grossEarnings: grossEarnings.toFixed(2),
              commission: commission.toFixed(2),
              adjustments: adjustments.toFixed(2),
              netPayable: netPayable.toFixed(2),
              walletCredited: netPayable.gt(0) ? netPayable.toFixed(2) : '0.00',
            },
            result: 'SUCCESS',
          });
        }
        return settlement;
      });
    } catch (err) {
      // Two runs settling the same driver and period: the unique key lets one commit,
      // and this one — credit and audit row included — rolled back. The winner is the
      // answer, so a concurrent run is not reported as a failure.
      if (err instanceof UniqueConstraintError || (err as { code?: unknown })?.code === 'P2002') {
        const winner = await this.settlementRepo.findByDriverAndPeriod(
          data.driverId,
          data.periodStart,
          data.periodEnd,
        );
        if (winner) return winner;
      }
      throw err;
    }
  }
  /// The production entry point: given a window, find every driver with a
  /// completed ride in it and settle each one. This is what closes the gap
  /// the platform audit found — `calculateSettlement` existed but nothing
  /// ever supplied it a driver to run against.
  ///
  /// `failed` names the drivers whose settlement rolled back, so a caller that must not
  /// proceed on a partial run — finance's batch — can refuse to.
  async calculateSettlementsForPeriod(
    periodStart: Date,
    periodEnd: Date,
    actor?: AuditActor,
  ): Promise<{ settled: number; failed: string[] }> {
    const driverIds = await this.settlementRepo.findDriverIdsWithCompletedRides(
      periodStart,
      periodEnd,
    );
    let settled = 0;
    const failed: string[] = [];
    for (const driverId of driverIds) {
      try {
        await this.calculateSettlement({ driverId, periodStart, periodEnd }, actor);
        settled++;
      } catch (err) {
        failed.push(driverId);
        logger.error(
          { err, driverId, periodStart, periodEnd },
          '[payments] settlement failed for driver',
        );
      }
    }
    return { settled, failed };
  }
}
