import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { DriverBankAccount } from '../types';
import { protectAccountNumber } from '@shared/crypto/bank-account-crypto.js';
export class DriverBankRepository {
  constructor(private readonly db: DatabaseService) {}
  async createAccount(
    data: {
      driverId: string;
      accountHolderName: string;
      bankName: string;
      ifscCode: string;
      /// Plaintext as entered. Encrypted here; never stored as-is.
      accountNumber: string;
      upiId?: string;
      isDefault?: boolean;
      enteredBy?: string;
    },
    tx?: TransactionClient,
  ): Promise<DriverBankAccount> {
    const client = tx ?? this.db.client;
    const bankNumber = protectAccountNumber(data.accountNumber);
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
        accountNumberEnc: null,
        accountNumberCiphertext: bankNumber.ciphertext,
        accountNumberLast4: bankNumber.last4,
        accountNumberHash: bankNumber.hash,
        encryptionKeyVersion: bankNumber.keyVersion,
        upiId: data.upiId ?? null,
        isDefault: data.isDefault ?? true,
        payoutEnabled: false,
        status: 'ENTERED',
        verificationStatus: 'PENDING',
        enteredBy: data.enteredBy ?? null,
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
