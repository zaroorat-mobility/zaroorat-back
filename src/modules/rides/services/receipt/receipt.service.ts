import { RideReceiptRepository } from '../../repositories/ride-receipt.repository.js';
import { RideRepository } from '../../repositories/ride.repository.js';
import { RideNotFoundError } from '../../errors/ride.errors.js';
import type { RideReceipt } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';

export class ReceiptService {
  constructor(
    private readonly receiptRepo: RideReceiptRepository,
    private readonly rideRepo: RideRepository,
  ) {}

  async generateReceipt(rideId: string, tx?: TransactionClient): Promise<RideReceipt> {
    const existing = await this.receiptRepo.findByRideId(rideId, tx);
    if (existing) return existing;

    const ride = await this.rideRepo.findById(rideId, tx);
    if (!ride) throw new RideNotFoundError(rideId);

    const snapshotJson = {
      rideId: ride.id,
      rideCode: ride.rideCode,
      customerId: ride.customerId,
      driverId: ride.driverId,
      status: ride.status,
      paymentMethod: ride.paymentMethod,
      fare: (ride as { fare?: unknown }).fare ?? null,
      issuedAt: new Date().toISOString(),
    };

    return this.receiptRepo.create(rideId, snapshotJson, null, tx);
  }
}
