import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal, type RideCancellation } from '../types';

export class RideCancellationRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(
    data: {
      rideId: string;
      cancelledBy: string;
      actorId?: string | null;
      reasonCode: string;
      reasonText?: string | null;
      cancelledAtStatus?: string | null;
      cancellationFee?: Decimal;
      feeCharged?: boolean;
    },
    tx?: TransactionClient,
  ): Promise<RideCancellation> {
    const client = tx ?? this.db.client;

    return client.rideCancellation.create({
      data: {
        rideId: data.rideId,
        cancelledBy: data.cancelledBy,
        reasonCode: data.reasonCode,
        cancellationFee: data.cancellationFee ?? new Decimal(0),
        feeCharged: data.feeCharged ?? false,
        ...(data.actorId !== undefined ? { actorId: data.actorId } : {}),
        ...(data.reasonText !== undefined ? { reasonText: data.reasonText } : {}),
        ...(data.cancelledAtStatus !== undefined
          ? { cancelledAtStatus: data.cancelledAtStatus }
          : {}),
      },
    });
  }

  async findByRideId(rideId: string, tx?: TransactionClient): Promise<RideCancellation | null> {
    const client = tx ?? this.db.client;
    return client.rideCancellation.findUnique({
      where: { rideId },
    });
  }
}
