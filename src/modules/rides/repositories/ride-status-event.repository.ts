import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RideStatusEvent } from '../types';
export class RideStatusEventRepository {
  constructor(private readonly db: DatabaseService) {}
  async record(
    data: {
      rideId: string;
      fromStatus?: string | null;
      toStatus: string;
      actorType?: string | null;
      actorId?: string | null;
      reason?: string | null;
    },
    tx?: TransactionClient,
  ): Promise<RideStatusEvent> {
    const client = tx ?? this.db.client;
    return client.rideStatusEvent.create({
      data: {
        rideId: data.rideId,
        toStatus: data.toStatus,
        ...(data.fromStatus !== undefined ? { fromStatus: data.fromStatus } : {}),
        ...(data.actorType !== undefined ? { actorType: data.actorType } : {}),
        ...(data.actorId !== undefined ? { actorId: data.actorId } : {}),
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
      },
    });
  }
  async listByRideId(rideId: string, tx?: TransactionClient): Promise<RideStatusEvent[]> {
    const client = tx ?? this.db.client;
    return client.rideStatusEvent.findMany({
      where: { rideId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
