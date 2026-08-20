import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Chargeback } from '../types';
export class ChargebackRepository {
  constructor(private readonly db: DatabaseService) {}
  async create(
    data: {
      transactionId: string;
      rideId?: string | null;
      amount: Decimal;
      reasonCode?: string | null;
      gatewayCaseId?: string | null;
    },
    tx?: TransactionClient,
  ): Promise<Chargeback> {
    const client = tx ?? this.db.client;
    return client.chargeback.create({
      data: {
        transactionId: data.transactionId,
        rideId: data.rideId ?? null,
        amount: data.amount,
        reasonCode: data.reasonCode ?? null,
        gatewayCaseId: data.gatewayCaseId ?? null,
        status: 'OPEN',
      },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<Chargeback | null> {
    const client = tx ?? this.db.client;
    return client.chargeback.findUnique({
      where: { id },
    });
  }
  async updateStatus(id: string, status: string, tx?: TransactionClient): Promise<Chargeback> {
    const client = tx ?? this.db.client;
    return client.chargeback.update({
      where: { id },
      data: {
        status,
        ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
      },
    });
  }
}
