import { TransactionManager } from '@core/database';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverStatusRepository } from '@modules/drivers/repositories/driver-status.repository.js';
import { VehicleRepository, type UpdateVehicleInput } from '../repositories/vehicle.repository.js';
import { VehicleAssignmentRepository } from '../repositories/vehicle-assignment.repository.js';
import { VehicleTypeService } from './vehicle-type.service.js';
import {
  NoActiveVehicleError,
  VehicleAlreadyAssignedError,
  VehicleInUseError,
  VehicleNotOwnedError,
} from '../errors/vehicle.errors.js';
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

/// Fields a driver may edit on their own vehicle. Deliberately excludes
/// `registrationNumber` and `vehicleTypeId`: both are what an operator reviewed
/// and what `assertVehicleEligible` matches a ride request against, so changing
/// either is a re-claim, not an edit.
export type DriverEditableVehicleInput = UpdateVehicleInput;

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
    private readonly driverStatusRepository: DriverStatusRepository,
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly txManager: TransactionManager,
  ) {}

  async claimVehicle(input: ClaimVehicleInput): Promise<Vehicle> {
    // Outside the transaction on purpose: a bad vehicle type is a client error
    // that should never have opened one. Throws VEHICLE_TYPE_NOT_FOUND (404) or
    // VEHICLE_TYPE_INACTIVE (409).
    await this.vehicleTypeService.requireActive(input.vehicleTypeId);

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
      } else if (vehicle.vehicleTypeId !== input.vehicleTypeId) {
        // Re-claiming an existing plate under a different category changes what
        // the vehicle is: whatever an operator approved no longer describes it.
        await tx.vehicle.update({
          where: { id: vehicle.id },
          data: { vehicleTypeId: input.vehicleTypeId },
        });
        vehicle = await this.vehicleRepo.resetVerification(vehicle.id, tx);
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

  /// The driver's own vehicle, with its type and documents. Returns null rather
  /// than throwing so a driver mid-onboarding gets an empty result, not a 404.
  async findMyVehicle(driverId: string) {
    return this.vehicleRepo.findByCurrentDriver(driverId);
  }

  private async assertOwned(vehicleId: string, driverId: string): Promise<Vehicle> {
    const assignment = await this.assignmentRepo.findActiveForDriver(driverId);
    if (!assignment || assignment.vehicleId !== vehicleId) {
      throw new VehicleNotOwnedError(vehicleId);
    }
    const vehicle = await this.vehicleRepo.findById(vehicleId);
    if (!vehicle) throw new VehicleNotOwnedError(vehicleId);
    return vehicle;
  }

  async updateVehicle(
    vehicleId: string,
    driverId: string,
    changes: DriverEditableVehicleInput,
  ): Promise<Vehicle> {
    const vehicle = await this.assertOwned(vehicleId, driverId);
    if (Object.keys(changes).length === 0) return vehicle;

    return this.txManager.execute(async (tx) => {
      const locked = await this.vehicleRepo.lockForUpdate(vehicleId, tx);
      if (!locked) throw new VehicleNotOwnedError(vehicleId);
      const updated = await this.vehicleRepo.update(vehicleId, changes, tx);
      // Editing the details an operator signed off on retires that approval.
      if (locked.verificationStatus === 'VERIFIED') {
        return this.vehicleRepo.resetVerification(vehicleId, tx);
      }
      return updated;
    });
  }

  /// Ends the driver's assignment. Deliberately does NOT deactivate the vehicle:
  /// the row outlives the assignment so another driver can claim the same plate.
  async releaseVehicle(driverId: string): Promise<void> {
    // Releasing mid-trip would strip the vehicle out from under a ride whose
    // accept-time check already validated it. `StatusService.setOffline` refuses
    // an ON_TRIP driver for the same reason.
    const status = await this.driverStatusRepository.getStatus(driverId);
    if (status?.status === 'ON_TRIP') throw new VehicleInUseError();

    await this.txManager.execute(async (tx) => {
      const assignment = await this.assignmentRepo.findActiveForDriver(driverId, tx);
      if (!assignment) throw new NoActiveVehicleError();
      await this.assignmentRepo.releaseActiveForDriver(driverId, tx);
      await this.vehicleRepo.setCurrentDriver(assignment.vehicleId, null, tx);
      await this.driverRepository.updateCurrentVehicle(driverId, null, tx);
    });
  }
}
