import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { RefundRepository } from '../../repositories/refund.repository.js';
import { PaymentGatewayProvider } from '../gateway/gateway.provider.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { RefundNotAllowedError } from '../../errors/payment.errors.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { Refund } from '../../types';

export class RefundService {
  constructor(
    private readonly refundRepo: RefundRepository,
    private readonly gateway: PaymentGatewayProvider,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  async processRefund(data: {
    transactionId: string;
    userId: string;
    amount: Decimal;
    reason?: string;
    idempotencyKey: string;
    actorIsStaff?: boolean;
  }): Promise<Refund> {
    if (data.amount.lte(0)) {
      throw new RefundNotAllowedError('Refund amount must be strictly greater than zero');
    }

    const existing = await this.refundRepo.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return existing;

    const transaction = await this.refundRepo.findTransactionForRefund(data.transactionId);
    if (!transaction) {
      throw new RefundNotAllowedError('This transaction cannot be refunded');
    }
    if (transaction.userId !== data.userId && data.actorIsStaff !== true) {
      throw new RefundNotAllowedError('This transaction cannot be refunded');
    }

    return this.txManager.execute(async (tx) => {
      const totalAlreadyRefunded = await this.refundRepo.getTotalRefundedForTransaction(
        data.transactionId,
        tx,
      );
      const remainingRefundable = transaction.amount.sub(totalAlreadyRefunded);

      if (data.amount.gt(remainingRefundable)) {
        this.paymentMetrics.refundFailure({ transactionId: data.transactionId });
        throw new RefundNotAllowedError(
          `Refund amount (${data.amount}) exceeds remaining captured amount (${remainingRefundable})`,
        );
      }

      const refundRecord = await this.refundRepo.create(
        {
          transactionId: data.transactionId,
          userId: data.userId,
          amount: data.amount,
          reason: data.reason ?? null,
          idempotencyKey: data.idempotencyKey,
        },
        tx,
      );

      const gatewayRes = await this.gateway.createRefund(
        data.transactionId,
        data.amount,
        data.idempotencyKey,
      );

      const updated = await this.refundRepo.updateStatus(
        refundRecord.id,
        'SUCCEEDED',
        gatewayRes.gatewayRefundId,
        tx,
      );

      await this.ledgerService.postTransactionGroup(
        [
          {
            account: 'CUSTOMER_WALLET',
            accountRefId: data.userId,
            direction: 'DEBIT',
            amount: data.amount,
            referenceType: 'REFUND',
            referenceId: refundRecord.id,
            description: `Refund debited for transaction ${data.transactionId}`,
          },
          {
            account: 'GATEWAY_CLEARING',
            direction: 'CREDIT',
            amount: data.amount,
            referenceType: 'REFUND',
            referenceId: refundRecord.id,
            description: `Gateway refund credit for transaction ${data.transactionId}`,
          },
        ],
        tx,
      );

      this.paymentMetrics.refundProcessed({ refundId: refundRecord.id });

      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.REFUND_PROCESSED, data.userId, {
          refundId: refundRecord.id,
          amount: data.amount.toNumber(),
        }),
        tx,
      );

      return updated;
    });
  }
}
