import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { WalletRechargeOption } from '../types';

/// spec.md FR-008b — company-configurable predefined recharge amounts.
export class WalletRechargeOptionRepository {
  constructor(private readonly db: DatabaseService) {}

  async listActive(tx?: TransactionClient): Promise<WalletRechargeOption[]> {
    const client = tx ?? this.db.client;
    return client.walletRechargeOption.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findById(id: string, tx?: TransactionClient): Promise<WalletRechargeOption | null> {
    const client = tx ?? this.db.client;
    return client.walletRechargeOption.findUnique({ where: { id } });
  }

  async create(
    data: { amount: Decimal; label?: string | null; sortOrder?: number },
    tx?: TransactionClient,
  ): Promise<WalletRechargeOption> {
    const client = tx ?? this.db.client;
    return client.walletRechargeOption.create({
      data: {
        amount: data.amount,
        label: data.label ?? null,
        sortOrder: data.sortOrder ?? 0,
        status: 'ACTIVE',
      },
    });
  }

  async setStatus(
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    tx?: TransactionClient,
  ): Promise<WalletRechargeOption> {
    const client = tx ?? this.db.client;
    return client.walletRechargeOption.update({ where: { id }, data: { status } });
  }
}
