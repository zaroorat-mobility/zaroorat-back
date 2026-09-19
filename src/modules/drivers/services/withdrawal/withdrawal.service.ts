import { DatabaseService } from '@core/database';
import { Decimal } from '../../types';
import { DriverError } from '../../errors/driver.errors.js';
import { DriverWalletRepository } from '../../repositories/driver-wallet.repository.js';
import { DriverBankRepository } from '../../repositories/driver-bank.repository.js';

export class InsufficientWalletBalanceError extends DriverError {
  constructor(message = 'Insufficient wallet balance for withdrawal') {
    super(message, 'INSUFFICIENT_WALLET_BALANCE', 400);
    this.name = 'InsufficientWalletBalanceError';
  }
}

export class WithdrawalNotAllowedError extends DriverError {
  constructor(message: string) {
    super(message, 'WITHDRAWAL_NOT_ALLOWED', 400);
    this.name = 'WithdrawalNotAllowedError';
  }
}

export class DriverWithdrawalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly driverWalletRepository: DriverWalletRepository,
    private readonly driverBankRepository: DriverBankRepository,
  ) {}

  async list(driverId: string, limit = 20) {
    const rows = await this.db.client.withdrawalRequest.findMany({
      where: { driverId },
      orderBy: { requestedAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      status: row.status,
      bankAccountId: row.bankAccountId,
      rejectionReason: row.rejectionReason,
      requestedAt: row.requestedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
    }));
  }

  async create(
    driverId: string,
    amount: number,
    bankAccountId?: string,
  ): Promise<{
    id: string;
    amount: number;
    status: string;
    bankAccountId: string | null;
    requestedAt: string;
  }> {
    await this.driverWalletRepository.getOrCreateWallet(driverId);

    let resolvedBankId = bankAccountId ?? null;
    const accounts = await this.driverBankRepository.findByDriverId(driverId);
    if (resolvedBankId) {
      const bank = accounts.find((a) => a.id === resolvedBankId);
      if (!bank) {
        throw new WithdrawalNotAllowedError('Bank account not found for this driver');
      }
    } else {
      const preferred = accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
      resolvedBankId = preferred?.id ?? null;
    }

    const created = await this.db.client.$transaction(async (tx) => {
      const locked = await this.driverWalletRepository.lockForUpdate(driverId, tx);
      if (!locked) throw new WithdrawalNotAllowedError('Driver wallet not found');
      const avail = Number(locked.balance) - Number(locked.lockedBalance);
      if (amount > avail) throw new InsufficientWalletBalanceError();

      const updated = await tx.driverWallet.update({
        where: { id: locked.id },
        data: { lockedBalance: new Decimal(Number(locked.lockedBalance) + amount) },
      });

      return tx.withdrawalRequest.create({
        data: {
          driverId,
          walletId: updated.id,
          amount: new Decimal(amount),
          status: 'REQUESTED',
          ...(resolvedBankId ? { bankAccountId: resolvedBankId } : {}),
        },
      });
    });

    return {
      id: created.id,
      amount: Number(created.amount),
      status: created.status,
      bankAccountId: created.bankAccountId,
      requestedAt: created.requestedAt.toISOString(),
    };
  }
}
