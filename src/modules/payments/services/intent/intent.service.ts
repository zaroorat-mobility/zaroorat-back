import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { IntentRepository } from '../../repositories/intent.repository.js';
import { PaymentGatewayProvider } from '../gateway/gateway.provider.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { InvalidStateTransitionError, PaymentNotFoundError } from '../../errors/payment.errors.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '../../events/catalog.js';
import { PaymentMetrics } from '../../metrics/payment.metrics.js';
import type { PaymentIntent } from '../../types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  CREATED: ['PENDING', 'PROCESSING', 'CANCELLED'],
  PENDING: ['PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: ['REFUND_PENDING', 'REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUND_PENDING: ['REFUNDED'],
  REFUNDED: [],
};

export class IntentService {
  constructor(
    private readonly intentRepo: IntentRepository,
    private readonly gateway: PaymentGatewayProvider,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
  ) {}

  validateTransition(fromState: string, toState: string): void {
    const allowed = ALLOWED_TRANSITIONS[fromState] ?? [];
    if (!allowed.includes(toState)) {
      throw new InvalidStateTransitionError(fromState, toState);
    }
  }

  async createIntent(data: {
    userId: string;
    rideId?: string;
    amount: Decimal;
    methodType: string;
    paymentMethodId?: string;
    idempotencyKey: string;
  }): Promise<PaymentIntent> {
    const existing = await this.intentRepo.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return existing;

    const gatewayRes = await this.gateway.createIntent({
      amount: data.amount,
      currency: 'INR',
      idempotencyKey: data.idempotencyKey,
      metadata: { userId: data.userId, rideId: data.rideId ?? '' },
    });

    return this.txManager.execute(async (tx) => {
      const intent = await this.intentRepo.create(
        {
          userId: data.userId,
          rideId: data.rideId ?? null,
          amount: data.amount,
          methodType: data.methodType,
          paymentMethodId: data.paymentMethodId ?? null,
          idempotencyKey: data.idempotencyKey,
          gateway: this.gateway.gatewayName,
          gatewayIntentId: gatewayRes.gatewayIntentId,
        },
        tx,
      );

      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.INTENT_CREATED, data.userId, {
          intentId: intent.id,
          amount: data.amount.toNumber(),
          gatewayIntentId: gatewayRes.gatewayIntentId,
        }),
        tx,
      );

      return intent;
    });
  }

  /** Load an intent, for callers that must authorize against its owner. */
  async findById(intentId: string): Promise<PaymentIntent | null> {
    return this.intentRepo.findById(intentId);
  }

  /**
   * Resolve the intent a gateway reference names.
   *
   * A webhook identifies the payment in the **gateway's** id space, so the
   * gateway column is tried first; our own primary key is accepted as a
   * fallback for payloads that echo it. A reference that is neither is reported
   * as `null` rather than raising — an unmatched webhook is a routing question,
   * not a server fault.
   */
  async findByGatewayReference(
    reference: string,
    tx?: TransactionClient,
  ): Promise<PaymentIntent | null> {
    const byGateway = await this.intentRepo.findByGatewayIntentId(reference, tx);
    if (byGateway) return byGateway;

    if (!UUID_PATTERN.test(reference)) return null;
    return this.intentRepo.findById(reference, tx);
  }

  async confirmIntent(intentId: string): Promise<PaymentIntent> {
    const intent = await this.intentRepo.findById(intentId);
    if (!intent) throw new PaymentNotFoundError(intentId);

    this.validateTransition(intent.status, 'PROCESSING');

    const confirmedGateway = await this.gateway.confirmIntent(intent.gatewayIntentId ?? intent.id);

    return this.txManager.execute((tx) =>
      this.applyConfirmation(
        intentId,
        confirmedGateway.status,
        confirmedGateway.gatewayIntentId,
        tx,
      ),
    );
  }

  async applyConfirmation(
    intentId: string,
    gatewayStatus: string,
    gatewayTxnId: string | null | undefined,
    tx: TransactionClient,
  ): Promise<PaymentIntent> {
    const locked = await this.intentRepo.lockForUpdate(intentId, tx);
    if (!locked) throw new PaymentNotFoundError(intentId);

    const nextStatus = gatewayStatus === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';

    if (locked.status === nextStatus) return locked;

    this.validateTransition(locked.status, nextStatus);

    const intent = locked;
    const updated = await this.intentRepo.updateStatus(
      intentId,
      nextStatus,
      intent.gatewayIntentId,
      tx,
    );

    await this.intentRepo.recordTransaction(
      {
        intentId,
        userId: intent.userId,
        rideId: intent.rideId,
        txnType: 'PAYMENT',
        amount: intent.amount,
        status: nextStatus,
        gateway: intent.gateway,
        gatewayTxnId: gatewayTxnId ?? intent.gatewayIntentId,
      },
      tx,
    );

    if (nextStatus === 'SUCCEEDED') {
      this.paymentMetrics.success({ intentId });

      await this.ledgerService.postTransactionGroup(
        [
          {
            account: 'GATEWAY_CLEARING',
            direction: 'DEBIT',
            amount: intent.amount,
            referenceType: 'PAYMENT_INTENT',
            referenceId: intentId,
            description: `Payment intent ${intentId} settled via gateway`,
          },
          {
            account: 'CUSTOMER_WALLET',
            accountRefId: intent.userId,
            direction: 'CREDIT',
            amount: intent.amount,
            referenceType: 'PAYMENT_INTENT',
            referenceId: intentId,
            description: `Payment intent ${intentId} credited`,
          },
        ],
        tx,
      );

      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.PAYMENT_SUCCEEDED, intent.userId, {
          intentId,
          amount: intent.amount.toNumber(),
        }),
        tx,
      );
    } else {
      this.paymentMetrics.failure({ intentId });

      await this.eventPublisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.PAYMENT_FAILED, intent.userId, {
          intentId,
          amount: intent.amount.toNumber(),
        }),
        tx,
      );
    }

    return updated;
  }
}
