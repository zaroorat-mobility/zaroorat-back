import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Vehicle } from '../types/index.js';
export interface CreateVehicleInput {
  registrationNumber: string;
  vehicleTypeId: string;
  make?: string;
  model?: string;
  color?: string;
  seatingCapacity?: number;
}
export class VehicleRepository {
  constructor(private readonly db: DatabaseService) {}
  async findById(id: string, tx?: TransactionClient): Promise<Vehicle | null> {
    const client = tx ?? this.db.client;
    return client.vehicle.findUnique({ where: { id } });
  }
  async findByRegistration(
    registrationNumber: string,
    tx?: TransactionClient,
  ): Promise<Vehicle | null> {
    const client = tx ?? this.db.client;
    return client.vehicle.findUnique({ where: { registrationNumber } });
  }
  async create(input: CreateVehicleInput, tx?: TransactionClient): Promise<Vehicle> {
    const client = tx ?? this.db.client;
    return client.vehicle.create({
      data: {
        registrationNumber: input.registrationNumber,
        vehicleTypeId: input.vehicleTypeId,
        ...(input.make !== undefined ? { make: input.make } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.seatingCapacity !== undefined ? { seatingCapacity: input.seatingCapacity } : {}),
        isActive: true,
      },
    });
  }
  async setCurrentDriver(
    vehicleId: string,
    driverId: string | null,
    tx: TransactionClient,
  ): Promise<Vehicle> {
    return tx.vehicle.update({ where: { id: vehicleId }, data: { currentDriverId: driverId } });
  }
}
