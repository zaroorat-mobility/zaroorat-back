import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { SubscriptionPlan } from '../types';

/// spec.md FR-001. Billing period is DAILY | WEEKLY | MONTHLY.
export class SubscriptionPlanRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(id: string, tx?: TransactionClient): Promise<SubscriptionPlan | null> {
    const client = tx ?? this.db.client;
    return client.subscriptionPlan.findUnique({ where: { id } });
  }

  async listActive(tx?: TransactionClient): Promise<SubscriptionPlan[]> {
    const client = tx ?? this.db.client;
    return client.subscriptionPlan.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { price: 'asc' },
    });
  }

  async create(
    data: { name: string; billingPeriod: string; price: Decimal; currency?: string },
    tx?: TransactionClient,
  ): Promise<SubscriptionPlan> {
    const client = tx ?? this.db.client;
    return client.subscriptionPlan.create({
      data: {
        name: data.name,
        billingPeriod: data.billingPeriod,
        price: data.price,
        currency: data.currency ?? 'INR',
        status: 'ACTIVE',
      },
    });
  }

  async setStatus(
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    tx?: TransactionClient,
  ): Promise<SubscriptionPlan> {
    const client = tx ?? this.db.client;
    return client.subscriptionPlan.update({ where: { id }, data: { status } });
  }
}
