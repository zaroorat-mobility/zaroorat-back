import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { PayoutRepository } from '../../repositories/payout.repository.js';
import { SettlementRepository } from '../../repositories/settlement.repository.js';
import { PaymentGatewayProvider } from '../gateway/gateway.provider.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import {
  InvalidPayoutAmountError,
  PayoutExceedsAvailableError,
  PayoutUnbackedError,
} from '../../errors/payment.errors.js';
import type { DriverPayout } from '../../types';
export class PayoutService {
  constructor(
    private readonly payoutRepo: PayoutRepository,
    private readonly settlementRepo: SettlementRepository,
    private readonly gateway: PaymentGatewayProvider,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}
  async executePayout(data: {
    driverId: string;
    settlementId?: string;
    bankAccountId?: string;
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
        const committed = await this.payoutRepo.sumCommittedForSettlement(settlement.id, tx);
        const available = settlement.netPayable.sub(committed);
        if (data.amount.gt(available)) {
          throw new PayoutExceedsAvailableError(data.amount.toString(), available.toString());
        }
        const payoutRecord = await this.payoutRepo.createPayout(
          {
            driverId: data.driverId,
            settlementId: settlement.id,
            bankAccountId: data.bankAccountId ?? null,
            amount: data.amount,
            idempotencyKey: data.idempotencyKey,
            gateway: this.gateway.gatewayName,
          },
          tx,
        );
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.PAYOUT_INITIATED, data.driverId, {
            payoutId: payoutRecord.id,
            amount: data.amount.toNumber(),
          }),
          tx,
        );
        try {
          const gatewayRes = await this.gateway.createPayout(
            data.driverId,
            data.bankAccountId ?? 'default',
            data.amount,
            data.idempotencyKey,
          );
          const updated = await this.payoutRepo.updateStatus(
            payoutRecord.id,
            'COMPLETED',
            gatewayRes.gatewayPayoutId,
            null,
            tx,
          );
          const remaining = available.sub(data.amount);
          if (remaining.lte(0)) {
            await this.settlementRepo.updateStatus(settlement.id, 'PAID', tx);
          }
          await this.ledgerService.postTransactionGroup(
            [
              {
                account: 'DRIVER_PAYABLE',
                accountRefId: data.driverId,
                direction: 'DEBIT',
                amount: data.amount,
                referenceType: 'PAYOUT',
                referenceId: payoutRecord.id,
                description: `Bank payout completed for driver ${data.driverId}`,
              },
              {
                account: 'GATEWAY_CLEARING',
                direction: 'CREDIT',
                amount: data.amount,
                referenceType: 'PAYOUT',
                referenceId: payoutRecord.id,
                description: `Bank payout gateway clearance`,
              },
            ],
            tx,
          );
          this.paymentMetrics.payoutSuccess({ payoutId: payoutRecord.id });
          await this.eventPublisher.publish(
            paymentEvent(PAYMENT_EVENT_CATALOG.PAYOUT_COMPLETED, data.driverId, {
              payoutId: payoutRecord.id,
              amount: data.amount.toNumber(),
            }),
            tx,
          );
          return updated;
        } catch (err) {
          this.paymentMetrics.payoutFailure({ payoutId: payoutRecord.id });
          await this.payoutRepo.updateStatus(
            payoutRecord.id,
            'FAILED',
            null,
            err instanceof Error ? err.message : String(err),
            tx,
          );
          throw err;
        }
      });
    } catch (err) {
      if (isDuplicateIdempotencyKey(err)) {
        const winner = await this.payoutRepo.findByIdempotencyKey(data.idempotencyKey);
        if (winner) return winner;
      }
      throw err;
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
