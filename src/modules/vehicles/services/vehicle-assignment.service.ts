import { TransactionManager } from '@core/database';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { VehicleRepository } from '../repositories/vehicle.repository.js';
import { VehicleAssignmentRepository } from '../repositories/vehicle-assignment.repository.js';
import { VehicleAlreadyAssignedError } from '../errors/vehicle.errors.js';
import type { Vehicle } from '../types/index.js';
export interface ClaimVehicleInput {
  driverId: string;
  registrationNumber: string;
  vehicleTypeId: string;
  make?: string;
  model?: string;
  color?: string;
  seatingCapacity?: number;
}
/// Minimal self-service vehicle assignment: a driver registers (or re-claims)
/// the vehicle they're currently driving. This is the data path
/// `LifecycleService.acceptRideRequest`'s vehicle-ownership check reads from —
/// before this existed, `Driver.currentVehicleId` and `VehicleAssignment` were
/// modeled but nothing ever wrote to them, so there was nothing to validate
/// against.
export class VehicleAssignmentService {
  constructor(
    private readonly vehicleRepo: VehicleRepository,
    private readonly assignmentRepo: VehicleAssignmentRepository,
    private readonly driverRepository: DriverRepository,
    private readonly txManager: TransactionManager,
  ) {}
  async claimVehicle(input: ClaimVehicleInput): Promise<Vehicle> {
    return this.txManager.execute(async (tx) => {
      let vehicle = await this.vehicleRepo.findByRegistration(input.registrationNumber, tx);
      if (vehicle && vehicle.currentDriverId && vehicle.currentDriverId !== input.driverId) {
        throw new VehicleAlreadyAssignedError(input.registrationNumber);
      }
      if (!vehicle) {
        vehicle = await this.vehicleRepo.create(
          {
            registrationNumber: input.registrationNumber,
            vehicleTypeId: input.vehicleTypeId,
            ...(input.make !== undefined ? { make: input.make } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.color !== undefined ? { color: input.color } : {}),
            ...(input.seatingCapacity !== undefined
              ? { seatingCapacity: input.seatingCapacity }
              : {}),
          },
          tx,
        );
      }
      // Release whatever this driver was previously assigned to — a driver
      // has at most one active vehicle, so claiming a new one retires the old
      // one rather than leaving two ACTIVE rows for the same driver.
      await this.assignmentRepo.releaseActiveForDriver(input.driverId, tx);
      const previousVehicleId = (await this.driverRepository.findById(input.driverId, tx))
        ?.currentVehicleId;
      if (previousVehicleId && previousVehicleId !== vehicle.id) {
        await this.vehicleRepo.setCurrentDriver(previousVehicleId, null, tx);
      }
      await this.vehicleRepo.setCurrentDriver(vehicle.id, input.driverId, tx);
      await this.driverRepository.updateCurrentVehicle(input.driverId, vehicle.id, tx);
      await this.assignmentRepo.create({ driverId: input.driverId, vehicleId: vehicle.id }, tx);
      return { ...vehicle, currentDriverId: input.driverId };
    });
  }
}
