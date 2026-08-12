import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Refund } from '../types';

export class RefundRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(
    data: {
      transactionId: string;
      rideId?: string | null;
      userId: string;
      amount: Decimal;
      reason?: string | null;
      idempotencyKey: string;
    },
    tx?: TransactionClient,
  ): Promise<Refund> {
    const client = tx ?? this.db.client;
    return client.refund.create({
      data: {
        transactionId: data.transactionId,
        rideId: data.rideId ?? null,
        userId: data.userId,
        amount: data.amount,
        reason: data.reason ?? null,
        idempotencyKey: data.idempotencyKey,
        status: 'PENDING',
      },
    });
  }

  async findByIdempotencyKey(key: string, tx?: TransactionClient): Promise<Refund | null> {
    const client = tx ?? this.db.client;
    return client.refund.findUnique({
      where: { idempotencyKey: key },
    });
  }

  async findTransactionForRefund(
    transactionId: string,
    tx?: TransactionClient,
  ): Promise<{ id: string; userId: string; amount: Decimal; status: string } | null> {
    const client = tx ?? this.db.client;
    const txn = await client.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: { id: true, userId: true, amount: true, status: true },
    });
    return txn ?? null;
  }

  async getTotalRefundedForTransaction(
    transactionId: string,
    tx?: TransactionClient,
  ): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const aggregate = await client.refund.aggregate({
      where: { transactionId, status: { in: ['PENDING', 'SUCCEEDED'] } },
      _sum: { amount: true },
    });
    return aggregate._sum.amount ?? new Decimal(0);
  }

  async updateStatus(
    id: string,
    status: string,
    gatewayRefundId?: string | null,
    tx?: TransactionClient,
  ): Promise<Refund> {
    const client = tx ?? this.db.client;
    return client.refund.update({
      where: { id },
      data: {
        status,
        ...(gatewayRefundId ? { gatewayRefundId } : {}),
        ...(status === 'SUCCEEDED' ? { completedAt: new Date() } : {}),
      },
    });
  }
}
