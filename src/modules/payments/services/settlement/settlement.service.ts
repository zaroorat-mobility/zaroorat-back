import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { logger } from '@shared/logger/index.js';
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
  async calculateSettlement(data: {
    driverId: string;
    periodStart: Date;
    periodEnd: Date;
    adjustments?: Decimal;
  }): Promise<DriverSettlement> {
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
    const commission = earned.commission.sub(alreadyRecovered);
    // A period that ended owing carries into the next one and is deducted
    // before anything is payable (FR-020/FR-021). `adjustments` was a
    // parameter nothing ever supplied; an explicit value still wins, so a
    // finance correction can override the carry.
    const carried = Decimal.min(0, await this.settlementRepo.cumulativeNetPayable(data.driverId));
    const adjustments = data.adjustments ?? carried;
    const netPayable = grossEarnings.sub(commission).add(adjustments);
    return this.txManager.execute(async (tx) => {
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
      // A driver who ran cash-only rides can legitimately net negative here
      // (they owe commission out of pocket, see `aggregateEarnings`) — there
      // is nothing to credit, and crediting a negative amount isn't a wallet
      // debit this flow is meant to perform, so only positive payouts move
      // money. The settlement row itself is still written either way, as the
      // period's record of account.
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
      const settled = await this.settlementRepo.updateStatus(settlement.id, 'PAID', tx);
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.SETTLEMENT_COMPLETED, data.driverId, {
          settlementId: settlement.id,
          driverId: data.driverId,
          netPayable: netPayable.toNumber(),
        }),
        tx,
      );
      return settled;
    });
  }
  /// The production entry point: given a window, find every driver with a
  /// completed ride in it and settle each one. This is what closes the gap
  /// the platform audit found — `calculateSettlement` existed but nothing
  /// ever supplied it a driver to run against.
  async calculateSettlementsForPeriod(periodStart: Date, periodEnd: Date): Promise<number> {
    const driverIds = await this.settlementRepo.findDriverIdsWithCompletedRides(
      periodStart,
      periodEnd,
    );
    let settled = 0;
    for (const driverId of driverIds) {
      try {
        await this.calculateSettlement({ driverId, periodStart, periodEnd });
        settled++;
      } catch (err) {
        logger.error(
          { err, driverId, periodStart, periodEnd },
          '[payments] settlement failed for driver',
        );
      }
    }
    return settled;
  }
}
