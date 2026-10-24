import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { PaymentIntent, PaymentTransaction } from '../types';
import type { GatewayPaymentPurpose } from '../constants/payment.constants.js';
export interface CreateIntentInput {
  userId: string;
  rideId?: string | null;
  amount: Decimal;
  methodType: string;
  paymentMethodId?: string | null;
  idempotencyKey: string;
  gateway?: string | null;
  gatewayIntentId?: string | null;
  /// Always explicit — see `GATEWAY_PAYMENT_PURPOSES`. The column's
  /// 'CUSTOMER_WALLET_TOPUP' default only describes historical rows.
  purpose: GatewayPaymentPurpose;
}
export class IntentRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(input: CreateIntentInput, tx?: TransactionClient): Promise<PaymentIntent> {
    const client = tx ?? this.db.client;
    return client.paymentIntent.create({
      data: {
        userId: input.userId,
        rideId: input.rideId ?? null,
        amount: input.amount,
        currency: 'INR',
        methodType: input.methodType,
        paymentMethodId: input.paymentMethodId ?? null,
        idempotencyKey: input.idempotencyKey,
        // PENDING, not CREATED: the only caller registers the intent with the
        // gateway before this row exists, so it is already awaiting payment by
        // the time it is written. Persisting CREATED left the row in a state
        // the machine cannot move to SUCCEEDED, so a genuine gateway
        // confirmation was rejected as an invalid transition.
        status: 'PENDING',
        gateway: input.gateway ?? null,
        gatewayIntentId: input.gatewayIntentId ?? null,
        purpose: input.purpose,
      },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<PaymentIntent | null> {
    const client = tx ?? this.db.client;
    return client.paymentIntent.findUnique({
      where: { id },
      include: { transactions: true },
    });
  }
  async lockForUpdate(id: string, tx: TransactionClient): Promise<PaymentIntent | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "payment_intents" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.paymentIntent.findUnique({ where: { id } });
  }
  async findByGatewayIntentId(
    gatewayIntentId: string,
    tx?: TransactionClient,
  ): Promise<PaymentIntent | null> {
    const client = tx ?? this.db.client;
    return client.paymentIntent.findFirst({ where: { gatewayIntentId } });
  }
  async findByIdempotencyKey(key: string, tx?: TransactionClient): Promise<PaymentIntent | null> {
    const client = tx ?? this.db.client;
    return client.paymentIntent.findUnique({
      where: { idempotencyKey: key },
    });
  }
  async updateStatus(
    id: string,
    status: string,
    gatewayIntentId?: string | null,
    tx?: TransactionClient,
  ): Promise<PaymentIntent> {
    const client = tx ?? this.db.client;
    return client.paymentIntent.update({
      where: { id },
      data: {
        status,
        ...(gatewayIntentId ? { gatewayIntentId } : {}),
      },
    });
  }
  async recordTransaction(
    data: {
      intentId: string;
      userId: string;
      rideId?: string | null;
      txnType: string;
      amount: Decimal;
      status: string;
      gateway?: string | null;
      gatewayTxnId?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      /// The provider-reported currency of a CAPTURED_REVIEW hold row.
      currency?: string;
    },
    tx?: TransactionClient,
  ): Promise<PaymentTransaction> {
    const client = tx ?? this.db.client;
    return client.paymentTransaction.create({
      data: {
        intentId: data.intentId,
        userId: data.userId,
        rideId: data.rideId ?? null,
        txnType: data.txnType,
        amount: data.amount,
        currency: data.currency ?? 'INR',
        status: data.status,
        gateway: data.gateway ?? null,
        gatewayTxnId: data.gatewayTxnId ?? null,
        errorCode: data.errorCode ?? null,
        errorMessage: data.errorMessage ?? null,
      },
    });
  }
  /// Every applied (SUCCEEDED) or held (CAPTURED_REVIEW) record of one provider
  /// payment, on any intent: the rows INV-2's unique index allows at most one of.
  async findPaymentRecords(
    gateway: string | null,
    providerPaymentId: string,
    tx: TransactionClient,
  ): Promise<{ id: string; intentId: string; status: string }[]> {
    return tx.paymentTransaction.findMany({
      where: {
        txnType: 'PAYMENT',
        gateway,
        gatewayTxnId: providerPaymentId,
        status: { in: ['SUCCEEDED', 'CAPTURED_REVIEW'] },
      },
      select: { id: true, intentId: true, status: true },
    });
  }
  async findSucceededPayment(
    intentId: string,
    tx: TransactionClient,
  ): Promise<{ id: string; gatewayTxnId: string | null } | null> {
    return tx.paymentTransaction.findFirst({
      where: { intentId, txnType: 'PAYMENT', status: 'SUCCEEDED' },
      select: { id: true, gatewayTxnId: true },
    });
  }
  /// A Zaroorat refund in progress or done for this provider payment.
  async hasRefundFor(providerPaymentId: string, tx: TransactionClient): Promise<boolean> {
    const count = await tx.refund.count({
      where: { providerPaymentId, status: { in: ['PROCESSING', 'SUCCEEDED'] } },
    });
    return count > 0;
  }
  /// Read-only lookups for the payment-status view (005 T043): they never
  /// create a wallet or touch a row.
  async findCommissionWalletBalance(userId: string): Promise<Decimal | null> {
    const driver = await this.db.client.driver.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!driver) return null;
    const wallet = await this.db.client.driverCommissionWallet.findUnique({
      where: { driverId: driver.id },
      select: { balance: true },
    });
    return wallet?.balance ?? null;
  }
  async findSubscriptionFundedBy(intentId: string) {
    return this.db.client.driverSubscription.findFirst({
      where: { paymentIntentId: intentId },
      select: { id: true, status: true, startDate: true, expiryDate: true },
    });
  }
  async hasRefundResolvedReviewCase(intentId: string): Promise<boolean> {
    const count = await this.db.client.paymentReviewCase.count({
      where: { intentId, status: 'RESOLVED_REFUND' },
    });
    return count > 0;
  }
}
