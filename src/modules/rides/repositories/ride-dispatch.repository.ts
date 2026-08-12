import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RideDispatch, DispatchResponse } from '../types';

export class RideDispatchRepository {
  constructor(private readonly db: DatabaseService) {}

  async createOffer(
    data: {
      requestId: string;
      driverId: string;
      vehicleId?: string | null;
      driverDistanceM?: number | null;
      driverEtaSeconds?: number | null;
      dispatchRound?: number;
      expiresAt?: Date | null;
    },
    tx?: TransactionClient,
  ): Promise<RideDispatch> {
    const client = tx ?? this.db.client;

    return client.rideDispatch.create({
      data: {
        requestId: data.requestId,
        driverId: data.driverId,
        dispatchRound: data.dispatchRound ?? 1,
        response: 'PENDING',
        ...(data.vehicleId !== undefined ? { vehicleId: data.vehicleId } : {}),
        ...(data.driverDistanceM !== undefined ? { driverDistanceM: data.driverDistanceM } : {}),
        ...(data.driverEtaSeconds !== undefined ? { driverEtaSeconds: data.driverEtaSeconds } : {}),
        ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      },
    });
  }

  async findByRequestAndDriver(
    requestId: string,
    driverId: string,
    tx?: TransactionClient,
  ): Promise<RideDispatch | null> {
    const client = tx ?? this.db.client;
    return client.rideDispatch.findUnique({
      where: {
        requestId_driverId: { requestId, driverId },
      },
    });
  }

  async updateResponse(
    id: string,
    response: DispatchResponse,
    rejectReason?: string,
    tx?: TransactionClient,
  ): Promise<RideDispatch> {
    const client = tx ?? this.db.client;

    return client.rideDispatch.update({
      where: { id },
      data: {
        response,
        respondedAt: new Date(),
        ...(rejectReason !== undefined ? { rejectReason } : {}),
      },
    });
  }
}
