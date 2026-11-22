import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { PaymentInstrument } from '../types';
export class PaymentMethodRepository {
  constructor(private readonly db: DatabaseService) {}
  async listByUser(userId: string, tx?: TransactionClient): Promise<PaymentInstrument[]> {
    const client = tx ?? this.db.client;
    return client.paymentInstrument.findMany({
      where: { userId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }
}
