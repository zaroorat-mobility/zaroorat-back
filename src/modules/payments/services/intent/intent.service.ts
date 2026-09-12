import { Decimal } from '../../types/index.js';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { IntentRepository } from '../../repositories/intent.repository.js';
import { PaymentGatewayResolverService } from '../gateway/payment-gateway-resolver.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { CommissionWalletService } from '../commission-wallet/commission-wallet.service.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
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
    private readonly gatewayResolver: PaymentGatewayResolverService,
    private readonly ledgerService: LedgerService,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly paymentMetrics: PaymentMetrics,
    private readonly walletService: WalletService,
    private readonly commissionWalletService: CommissionWalletService,
    private readonly driverRepository: DriverRepository,
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
    /// 004-driver-subscription-wallet. Defaults to the existing behavior.
    purpose?: string;
  }): Promise<PaymentIntent> {
    const existing = await this.intentRepo.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return existing;
    // The active provider is resolved ONCE, here, at creation — the result is
    // what gets written to PaymentIntent.gateway below and is authoritative
    // for this intent's entire lifetime, regardless of any later change to
    // which provider is active. No purpose-based routing and no caller-chosen
    // provider: whichever gateway Admin has made active handles every new
    // intent, automatically.
    const gateway = await this.gatewayResolver.getActiveGateway();
    const gatewayRes = await gateway.createIntent({
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
          gateway: gateway.gatewayName,
          gatewayIntentId: gatewayRes.gatewayIntentId,
          ...(data.purpose !== undefined ? { purpose: data.purpose } : {}),
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
  async findById(intentId: string): Promise<PaymentIntent | null> {
    return this.intentRepo.findById(intentId);
  }
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
    // Resolved by the intent's OWN stored provider — never by current
    // routing, which may have changed since this intent was created.
    const gateway = await this.gatewayResolver.forProviderName(intent.gateway ?? 'mock');
    const confirmedGateway = await gateway.confirmIntent(intent.gatewayIntentId ?? intent.id);
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
      // 004-driver-subscription-wallet. `purpose` decides the SUCCEEDED
      // effect instead of unconditionally crediting the customer wallet — the
      // pre-existing behavior below is preserved exactly for the default
      // ('CUSTOMER_WALLET_TOPUP') purpose, additive branches handle the two
      // new ones.
      const purpose = intent.purpose;
      if (purpose === 'DRIVER_COMMISSION_RECHARGE') {
        // `intent.userId` is the caller's AUTH user id (FK-constrained to
        // `users`, matching every other PaymentIntent) — NOT the same id space
        // as `DriverCommissionWallet.driverId` (`Driver.id`). Resolved here,
        // not trusted from anywhere else, so the wallet is always credited
        // under the exact id `CommissionWalletService.hasSufficientBalance`/
        // `deductInTx` will later look it up by.
        const driver = await this.driverRepository.findByUserId(intent.userId, tx);
        if (!driver) {
          throw new Error(
            `Cannot credit Commission Wallet: no driver profile for user ${intent.userId}`,
          );
        }
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: 'GATEWAY_CLEARING',
              direction: 'DEBIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Commission wallet recharge ${intentId} settled via gateway`,
            },
            {
              account: 'DRIVER_COMMISSION_WALLET',
              accountRefId: driver.id,
              direction: 'CREDIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Commission wallet recharge ${intentId} credited`,
            },
          ],
          tx,
        );
        await this.commissionWalletService.creditInTx(driver.id, intent.amount, tx, {
          referenceType: 'PAYMENT_INTENT',
          referenceId: intentId,
          description: `Commission wallet funded by payment intent ${intentId}`,
        });
      } else if (purpose === 'DRIVER_SUBSCRIPTION_PAYMENT') {
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: 'GATEWAY_CLEARING',
              direction: 'DEBIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Subscription payment ${intentId} settled via gateway`,
            },
            {
              account: 'SUBSCRIPTION_REVENUE',
              direction: 'CREDIT',
              amount: intent.amount,
              referenceType: 'PAYMENT_INTENT',
              referenceId: intentId,
              description: `Subscription payment ${intentId} recognised`,
            },
          ],
          tx,
        );
        // Activation is NOT time-critical the way a wallet credit is, so it
        // goes through the outbox (constitution §1.5) rather than a direct
        // cross-module call — the subscriptions module's own consumer reacts.
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.DRIVER_SUBSCRIPTION_PAYMENT_COMPLETED, intent.userId, {
            paymentIntentId: intentId,
            driverUserId: intent.userId,
            amount: intent.amount.toNumber(),
          }),
          tx,
        );
      } else {
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
        // The balance moves here, in the same transaction as the ledger credit
        // above, and nowhere else. Previously `POST /wallet/topup` raised the
        // balance directly while this group was the only thing a provider
        // payment produced, so a request with no payment behind it minted
        // spendable balance and the two records could not agree (FR-036).
        await this.walletService.creditInTx(intent.userId, intent.amount, tx, {
          referenceType: 'PAYMENT_INTENT',
          referenceId: intentId,
          description: `Wallet funded by payment intent ${intentId}`,
        });
      }
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
