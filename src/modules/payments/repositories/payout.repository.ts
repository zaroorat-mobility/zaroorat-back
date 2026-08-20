import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverPayout, PayoutItem } from '../types';
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
  async updateStatus(
    id: string,
    status: string,
    gatewayPayoutId?: string | null,
    failureReason?: string | null,
    tx?: TransactionClient,
  ): Promise<DriverPayout> {
    const client = tx ?? this.db.client;
    return client.driverPayout.update({
      where: { id },
      data: {
        status,
        ...(gatewayPayoutId ? { gatewayPayoutId } : {}),
        ...(failureReason ? { failureReason } : {}),
        ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });
  }
  async addPayoutItem(
    payoutId: string,
    rideId: string | null,
    itemType: string,
    amount: Decimal,
    tx?: TransactionClient,
  ): Promise<PayoutItem> {
    const client = tx ?? this.db.client;
    return client.payoutItem.create({
      data: {
        payoutId,
        rideId: rideId ?? null,
        itemType,
        amount,
      },
    });
  }
}
