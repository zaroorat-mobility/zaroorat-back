import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { SettlementRepository } from '../../repositories/settlement.repository.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import type { DriverSettlement } from '../../types';
export class SettlementService {
  constructor(
    private readonly settlementRepo: SettlementRepository,
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
    const commission = earned.commission;
    const adjustments = data.adjustments ?? new Decimal(0);
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
      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.SETTLEMENT_COMPLETED, data.driverId, {
          settlementId: settlement.id,
          driverId: data.driverId,
          netPayable: netPayable.toNumber(),
        }),
        tx,
      );
      return settlement;
    });
  }
}
