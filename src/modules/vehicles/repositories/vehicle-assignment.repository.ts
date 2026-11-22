import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { VehicleAssignment } from '../types/index.js';
export class VehicleAssignmentRepository {
  constructor(private readonly db: DatabaseService) {}
  async findActiveForDriver(
    driverId: string,
    tx?: TransactionClient,
  ): Promise<VehicleAssignment | null> {
    const client = tx ?? this.db.client;
    return client.vehicleAssignment.findFirst({ where: { driverId, status: 'ACTIVE' } });
  }
  async create(
    data: { driverId: string; vehicleId: string; assignedBy?: string },
    tx: TransactionClient,
  ): Promise<VehicleAssignment> {
    return tx.vehicleAssignment.create({
      data: {
        driverId: data.driverId,
        vehicleId: data.vehicleId,
        status: 'ACTIVE',
        ...(data.assignedBy !== undefined ? { assignedBy: data.assignedBy } : {}),
      },
    });
  }
  /// Releases every ACTIVE assignment row for a driver — normally at most one,
  /// by the DB backstop (see the vehicle-assignment-uniqueness migration), but
  /// this doesn't assume that invariant holds, it enforces the release side of
  /// it regardless.
  async releaseActiveForDriver(driverId: string, tx: TransactionClient): Promise<void> {
    await tx.vehicleAssignment.updateMany({
      where: { driverId, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  }
}
