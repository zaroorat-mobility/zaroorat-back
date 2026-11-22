import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Prisma } from '../../../generated/prisma/index.js';
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
      driverCompensation?: Decimal;
      feeCharged?: boolean;
      feeStatus?: string;
      policyId?: string | null;
      policyVersion?: number | null;
      policySnapshot?: Prisma.InputJsonValue | null;
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
        driverCompensation: data.driverCompensation ?? new Decimal(0),
        feeCharged: data.feeCharged ?? false,
        feeStatus: data.feeStatus ?? 'WAIVED',
        ...(data.actorId !== undefined ? { actorId: data.actorId } : {}),
        ...(data.reasonText !== undefined ? { reasonText: data.reasonText } : {}),
        ...(data.cancelledAtStatus !== undefined
          ? { cancelledAtStatus: data.cancelledAtStatus }
          : {}),
        ...(data.policyId !== undefined ? { policyId: data.policyId } : {}),
        ...(data.policyVersion !== undefined ? { policyVersion: data.policyVersion } : {}),
        ...(data.policySnapshot !== undefined && data.policySnapshot !== null
          ? { policySnapshot: data.policySnapshot }
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
