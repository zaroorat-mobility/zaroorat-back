import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Refund } from '../types';

/// The payment a refund reverses, with the purpose of the intent that
/// collected it. The purpose decides which balance and which ledger accounts
/// the refund moves; `gatewayTxnId` is the PROVIDER's payment id.
export interface RefundableTransaction {
  id: string;
  userId: string;
  amount: Decimal;
  status: string;
  txnType: string;
  gateway: string | null;
  gatewayTxnId: string | null;
  rideId: string | null;
  intentId: string;
  purpose: string;
}

/// Money already promised back against a payment: requested, in flight, or done.
const COMMITTED_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED'];

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
      purpose?: string | null;
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
        purpose: data.purpose ?? null,
        status: 'PENDING',
      },
    });
  }

  async findById(id: string, tx?: TransactionClient): Promise<Refund | null> {
    const client = tx ?? this.db.client;
    return client.refund.findUnique({ where: { id } });
  }

  async findByIdempotencyKey(key: string, tx?: TransactionClient): Promise<Refund | null> {
    const client = tx ?? this.db.client;
    return client.refund.findUnique({ where: { idempotencyKey: key } });
  }

  /// Every state change of a refund happens under this lock, which is what
  /// makes the reservation, the settlement and the compensation exactly-once.
  async lockForUpdate(id: string, tx: TransactionClient): Promise<Refund | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "refunds" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.refund.findUnique({ where: { id } });
  }

  async findRefundableTransaction(
    transactionId: string,
    tx?: TransactionClient,
  ): Promise<RefundableTransaction | null> {
    const client = tx ?? this.db.client;
    const txn = await client.paymentTransaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        userId: true,
        amount: true,
        status: true,
        txnType: true,
        gateway: true,
        gatewayTxnId: true,
        rideId: true,
        intentId: true,
        intent: { select: { purpose: true } },
      },
    });
    if (!txn) return null;
    const { intent, ...rest } = txn;
    return { ...rest, purpose: intent.purpose };
  }

  /// Serialises every refund of one payment, so two concurrent refunds can
  /// never together exceed what was captured.
  async lockTransaction(
    transactionId: string,
    tx: TransactionClient,
  ): Promise<RefundableTransaction | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "payment_transactions" WHERE "id" = ${transactionId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return this.findRefundableTransaction(transactionId, tx);
  }

  async getCommittedForTransaction(
    transactionId: string,
    tx?: TransactionClient,
    excludeRefundId?: string,
  ): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const aggregate = await client.refund.aggregate({
      where: {
        transactionId,
        status: { in: COMMITTED_STATUSES },
        ...(excludeRefundId ? { id: { not: excludeRefundId } } : {}),
      },
      _sum: { amount: true },
    });
    return aggregate._sum.amount ?? new Decimal(0);
  }

  async markProcessing(
    id: string,
    data: { purpose: string; providerPaymentId: string; reservedAt: Date },
    tx: TransactionClient,
  ): Promise<Refund> {
    return tx.refund.update({
      where: { id },
      data: { status: 'PROCESSING', ...data },
    });
  }

  /// A short lease on talking to the provider. Only one caller — a request, a
  /// retry, or the reconciliation job — asks the provider about a refund at a
  /// time. One conditional UPDATE, so it is atomic.
  async claimDispatch(id: string, now: Date, leaseMs: number): Promise<boolean> {
    const { count } = await this.db.client.refund.updateMany({
      where: {
        id,
        status: 'PROCESSING',
        OR: [
          { lastDispatchAt: null },
          { lastDispatchAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      data: { dispatchAttempts: { increment: 1 }, lastDispatchAt: now },
    });
    return count === 1;
  }

  async recordDispatchError(id: string, message: string, tx: TransactionClient): Promise<Refund> {
    return tx.refund.update({
      where: { id },
      data: { lastDispatchError: message.slice(0, 500) },
    });
  }

  async setGatewayRefundId(
    id: string,
    gatewayRefundId: string,
    tx: TransactionClient,
  ): Promise<Refund> {
    return tx.refund.update({
      where: { id },
      data: { gatewayRefundId, lastDispatchError: null },
    });
  }

  async markSucceeded(id: string, gatewayRefundId: string, tx: TransactionClient): Promise<Refund> {
    return tx.refund.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        gatewayRefundId,
        completedAt: new Date(),
        lastDispatchError: null,
      },
    });
  }

  async markFailed(id: string, reason: string, tx: TransactionClient): Promise<Refund> {
    return tx.refund.update({
      where: { id },
      data: { status: 'FAILED', failedAt: new Date(), failureReason: reason.slice(0, 500) },
    });
  }

  /// Refunds the provider was, or may have been, asked about — and whose last
  /// attempt is old enough that nobody else is holding the dispatch lease.
  async findStaleProcessing(olderThan: Date, limit: number): Promise<Refund[]> {
    return this.db.client.refund.findMany({
      where: {
        status: 'PROCESSING',
        OR: [{ lastDispatchAt: null }, { lastDispatchAt: { lt: olderThan } }],
      },
      orderBy: { lastDispatchAt: 'asc' },
      take: limit,
    });
  }
}
