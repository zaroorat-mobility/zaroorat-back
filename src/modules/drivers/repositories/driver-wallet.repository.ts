import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal, type DriverWallet, type DriverWalletTransaction } from '../types';
export class DriverWalletRepository {
  constructor(private readonly db: DatabaseService) {}
  async getOrCreateWallet(driverId: string, tx?: TransactionClient): Promise<DriverWallet> {
    const client = tx ?? this.db.client;
    const existing = await client.driverWallet.findUnique({
      where: { driverId },
    });
    if (existing) return existing;
    return client.driverWallet.create({
      data: {
        driverId,
        balance: new Decimal(0),
        lockedBalance: new Decimal(0),
        currency: 'INR',
      },
    });
  }
  async listTransactions(
    driverId: string,
    limit = 20,
    tx?: TransactionClient,
  ): Promise<DriverWalletTransaction[]> {
    const client = tx ?? this.db.client;
    return client.driverWalletTransaction.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
