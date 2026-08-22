import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { Vehicle, VerificationStatus } from '../types/index.js';
export interface CreateVehicleInput {
  registrationNumber: string;
  vehicleTypeId: string;
  make?: string;
  model?: string;
  color?: string;
  seatingCapacity?: number;
}
export interface UpdateVehicleInput {
  make?: string;
  model?: string;
  color?: string;
  seatingCapacity?: number;
  registrationState?: string;
  fuelType?: string;
  manufacturingYear?: number;
}

export class VehicleRepository {
  constructor(private readonly db: DatabaseService) {}

  /// Same shape as `DriverRepository.lockForUpdate` — the raw SELECT ... FOR
  /// UPDATE is what makes claim/release/review serialise against each other.
  async lockForUpdate(id: string, tx: TransactionClient): Promise<Vehicle | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "vehicles" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.vehicle.findUnique({ where: { id } });
  }

  async findById(id: string, tx?: TransactionClient): Promise<Vehicle | null> {
    const client = tx ?? this.db.client;
    return client.vehicle.findUnique({ where: { id } });
  }

  async findByIdWithType(id: string, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    return client.vehicle.findUnique({ where: { id }, include: { vehicleType: true } });
  }

  async findByCurrentDriver(driverId: string, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    return client.vehicle.findFirst({
      where: { currentDriverId: driverId },
      include: { vehicleType: true, documents: true },
    });
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

  async update(id: string, input: UpdateVehicleInput, tx?: TransactionClient): Promise<Vehicle> {
    const client = tx ?? this.db.client;
    return client.vehicle.update({
      where: { id },
      data: {
        ...(input.make !== undefined ? { make: input.make } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.seatingCapacity !== undefined ? { seatingCapacity: input.seatingCapacity } : {}),
        ...(input.registrationState !== undefined
          ? { registrationState: input.registrationState }
          : {}),
        ...(input.fuelType !== undefined ? { fuelType: input.fuelType } : {}),
        ...(input.manufacturingYear !== undefined
          ? { manufacturingYear: input.manufacturingYear }
          : {}),
      },
    });
  }

  /// Any change to the vehicle's identifying details invalidates the review it
  /// already passed — the same reasoning `OnboardingService.submitDocument`
  /// applies when a VERIFIED driver re-submits a required document.
  async resetVerification(id: string, tx?: TransactionClient): Promise<Vehicle> {
    const client = tx ?? this.db.client;
    return client.vehicle.update({
      where: { id },
      data: {
        verificationStatus: 'PENDING',
        verifiedAt: null,
        verifiedBy: null,
        rejectionReason: null,
      },
    });
  }

  async updateVerificationStatus(
    id: string,
    verificationStatus: VerificationStatus,
    verifiedBy?: string,
    rejectionReason?: string,
    tx?: TransactionClient,
  ): Promise<Vehicle> {
    const client = tx ?? this.db.client;
    return client.vehicle.update({
      where: { id },
      data: {
        verificationStatus,
        ...(verificationStatus === 'VERIFIED'
          ? {
              verifiedAt: new Date(),
              ...(verifiedBy !== undefined ? { verifiedBy } : {}),
            }
          : { verifiedAt: null }),
        ...(rejectionReason !== undefined ? { rejectionReason } : {}),
      },
    });
  }
}
