import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { PaymentIntent, PaymentTransaction } from '../types';
export interface CreateIntentInput {
  userId: string;
  rideId?: string | null;
  amount: Decimal;
  methodType: string;
  paymentMethodId?: string | null;
  idempotencyKey: string;
  gateway?: string | null;
  gatewayIntentId?: string | null;
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
        status: 'CREATED',
        gateway: input.gateway ?? null,
        gatewayIntentId: input.gatewayIntentId ?? null,
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
        currency: 'INR',
        status: data.status,
        gateway: data.gateway ?? null,
        gatewayTxnId: data.gatewayTxnId ?? null,
        errorCode: data.errorCode ?? null,
        errorMessage: data.errorMessage ?? null,
      },
    });
  }
}
