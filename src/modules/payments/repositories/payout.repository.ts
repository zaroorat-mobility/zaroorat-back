import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverPayout } from '../types';
export class PayoutRepository {
  constructor(private readonly db: DatabaseService) {}
  async createPayout(
    data: {
      driverId: string;
      settlementId?: string | null;
      bankAccountId?: string | null;
      amount: Decimal;
      idempotencyKey: string;
      gateway?: string | null;
    },
    tx?: TransactionClient,
  ): Promise<DriverPayout> {
    const client = tx ?? this.db.client;
    return client.driverPayout.create({
      data: {
        driverId: data.driverId,
        settlementId: data.settlementId ?? null,
        bankAccountId: data.bankAccountId ?? null,
        amount: data.amount,
        idempotencyKey: data.idempotencyKey,
        status: 'INITIATED',
        gateway: data.gateway ?? null,
      },
    });
  }
  async findByIdempotencyKey(key: string, tx?: TransactionClient): Promise<DriverPayout | null> {
    const client = tx ?? this.db.client;
    return client.driverPayout.findUnique({
      where: { idempotencyKey: key },
    });
  }
  async sumCommittedForSettlement(settlementId: string, tx?: TransactionClient): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const aggregate = await client.driverPayout.aggregate({
      where: { settlementId, status: { not: 'FAILED' } },
      _sum: { amount: true },
    });
    return aggregate._sum.amount ?? new Decimal(0);
  }
  /// COMPLETED only: money that actually left the platform. This is what
  /// decides whether a settlement may be marked PAID — deliberately narrower
  /// than `sumCommittedForSettlement`, which also counts the INITIATED
  /// reservations that merely block a second payout of the same rupees.
  async sumCompletedForSettlement(settlementId: string, tx?: TransactionClient): Promise<Decimal> {
    const client = tx ?? this.db.client;
    const aggregate = await client.driverPayout.aggregate({
      where: { settlementId, status: 'COMPLETED' },
      _sum: { amount: true },
    });
    return aggregate._sum.amount ?? new Decimal(0);
  }

  /// `SELECT … FOR UPDATE` on one payout. The INITIATED → terminal transition
  /// is what makes the driver wallet debit exactly-once, so it has to be
  /// serialised against a concurrent confirmation of the same row.
  async lockForUpdate(id: string, tx: TransactionClient): Promise<DriverPayout | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "driver_payouts" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.driverPayout.findUnique({ where: { id } });
  }

  async markCompleted(
    id: string,
    externalReference: string,
    tx?: TransactionClient,
  ): Promise<DriverPayout> {
    const client = tx ?? this.db.client;
    return client.driverPayout.update({
      where: { id },
      data: { status: 'COMPLETED', externalReference, completedAt: new Date() },
    });
  }

  /// A failed payout is updated in its own committed transaction and is never
  /// deleted — the attempt is part of the audit trail. The previous code wrote
  /// FAILED and then rethrew from inside the same transaction, discarding it.
  async markFailed(
    id: string,
    failureReason: string,
    tx?: TransactionClient,
  ): Promise<DriverPayout> {
    const client = tx ?? this.db.client;
    return client.driverPayout.update({
      where: { id },
      data: { status: 'FAILED', failureReason },
    });
  }
}
