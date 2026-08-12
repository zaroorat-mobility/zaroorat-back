import { Decimal } from '../../types/index.js';
import { RideCancellationRepository } from '../../repositories/ride-cancellation.repository.js';
import type { Ride, RideCancellation } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';

export class CancellationService {
  constructor(private readonly cancellationRepo: RideCancellationRepository) {}

  async processCancellation(
    data: {
      ride: Ride;
      cancelledBy: 'CUSTOMER' | 'DRIVER' | 'SYSTEM';
      actorId?: string;
      reasonCode: string;
      reasonText?: string;
    },
    tx?: TransactionClient,
  ): Promise<RideCancellation> {
    let cancellationFee = new Decimal(0);
    let feeCharged = false;

    if (
      data.cancelledBy === 'CUSTOMER' &&
      (data.ride.status === 'DRIVER_ARRIVED' || data.ride.arrivedAt !== null)
    ) {
      cancellationFee = new Decimal(50);
      feeCharged = true;
    }

    return this.cancellationRepo.create(
      {
        rideId: data.ride.id,
        cancelledBy: data.cancelledBy,
        actorId: data.actorId ?? null,
        reasonCode: data.reasonCode,
        reasonText: data.reasonText ?? null,
        cancelledAtStatus: data.ride.status,
        cancellationFee,
        feeCharged,
      },
      tx,
    );
  }
}
