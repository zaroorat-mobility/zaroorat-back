import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverBankAccount } from '../types';

export class DriverBankRepository {
  constructor(private readonly db: DatabaseService) {}

  async createAccount(
    data: {
      driverId: string;
      accountHolderName: string;
      bankName: string;
      ifscCode: string;
      accountNumberEnc: string;
      upiId?: string;
      isDefault?: boolean;
    },
    tx?: TransactionClient,
  ): Promise<DriverBankAccount> {
    const client = tx ?? this.db.client;

    if (data.isDefault) {
      await client.driverBankAccount.updateMany({
        where: { driverId: data.driverId },
        data: { isDefault: false },
      });
    }

    return client.driverBankAccount.create({
      data: {
        driverId: data.driverId,
        accountHolderName: data.accountHolderName,
        bankName: data.bankName,
        ifscCode: data.ifscCode,
        accountNumberEnc: data.accountNumberEnc,
        upiId: data.upiId ?? null,
        isDefault: data.isDefault ?? true,
        payoutEnabled: false,
        verificationStatus: 'PENDING',
      },
    });
  }

  async findByDriverId(driverId: string, tx?: TransactionClient): Promise<DriverBankAccount[]> {
    const client = tx ?? this.db.client;
    return client.driverBankAccount.findMany({
      where: { driverId },
      orderBy: { isDefault: 'desc' },
    });
  }
}
