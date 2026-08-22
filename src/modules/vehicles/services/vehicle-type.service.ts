import {
  VehicleTypeRepository,
  type FindActiveTypesOptions,
} from '../repositories/vehicle-type.repository.js';
import { VehicleTypeInactiveError, VehicleTypeNotFoundError } from '../errors/vehicle.errors.js';
import type { VehicleType } from '../types/index.js';

/// The reusable lookup every other module goes through. Rides (quote, request)
/// and vehicles (claim) all validate a client-supplied `vehicleTypeId` here
/// rather than each reaching for Prisma and each inventing its own error.
export class VehicleTypeService {
  constructor(private readonly vehicleTypeRepository: VehicleTypeRepository) {}

  listActive(options: FindActiveTypesOptions = {}): Promise<VehicleType[]> {
    return this.vehicleTypeRepository.findActive(options);
  }

  async findById(id: string): Promise<VehicleType | null> {
    return this.vehicleTypeRepository.findById(id);
  }

  /// Resolves a type and asserts it is servable. Throws
  /// `VEHICLE_TYPE_NOT_FOUND` (404) for an unknown id and
  /// `VEHICLE_TYPE_INACTIVE` (409) for a real but retired one — two distinct
  /// outcomes a client must be able to tell apart.
  async requireActive(id: string): Promise<VehicleType> {
    const vehicleType = await this.vehicleTypeRepository.findById(id);
    if (!vehicleType) throw new VehicleTypeNotFoundError(id);
    if (!vehicleType.isActive) throw new VehicleTypeInactiveError(id);
    return vehicleType;
  }
}
