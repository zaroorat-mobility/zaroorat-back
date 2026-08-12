import { DriverWalletRepository } from '../../repositories/driver-wallet.repository.js';
import type { DriverWallet, DriverWalletTransaction } from '../../types';

export class DriverWalletViewService {
  constructor(private readonly driverWalletRepository: DriverWalletRepository) {}

  async getWallet(driverId: string): Promise<DriverWallet> {
    return this.driverWalletRepository.getOrCreateWallet(driverId);
  }

  async listTransactions(driverId: string, limit = 20): Promise<DriverWalletTransaction[]> {
    return this.driverWalletRepository.listTransactions(driverId, limit);
  }
}
