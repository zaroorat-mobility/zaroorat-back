import {
  VehicleTypeRepository,
  type FindActiveTypesOptions,
} from '../repositories/vehicle-type.repository.js';
import {
  VehicleTypeInactiveError,
  VehicleTypeNotFoundError,
  VehicleTypeAlreadyExistsError,
} from '../errors/vehicle.errors.js';
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

  async listAll(includeInactive = true): Promise<VehicleType[]> {
    return this.vehicleTypeRepository.findAll({ includeInactive });
  }

  async createVehicleType(data: {
    code: string;
    name: string;
    category?: string;
    hasAc?: boolean;
    badge?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    imageFileId?: string | null;
    icon?: string | null;
    passengerCapacity?: number | null;
    luggageCapacity?: number | null;
    displayOrder?: number;
    isActive?: boolean;
  }): Promise<VehicleType> {
    const cleanCode = data.code.trim().toUpperCase();

    // Check if a vehicle service with this code already exists
    const existing = await this.vehicleTypeRepository.findByCode(cleanCode);
    if (existing) {
      if (!existing.isActive) {
        // If it was previously disabled or deleted, gracefully reactivate and update it
        return this.vehicleTypeRepository.update(existing.id, {
          name: data.name.trim(),
          category: data.category || 'car',
          hasAc: data.hasAc ?? false,
          badge: data.badge ? data.badge.trim() : null,
          description: data.description ? data.description.trim() : null,
          imageUrl: data.imageUrl || null,
          imageFileId: data.imageFileId || null,
          icon: data.icon || null,
          passengerCapacity: data.passengerCapacity ?? 4,
          luggageCapacity: data.luggageCapacity ?? 2,
          displayOrder: data.displayOrder ?? existing.displayOrder,
          isActive: true,
        });
      }
      // If already active, throw clean domain conflict error
      throw new VehicleTypeAlreadyExistsError(cleanCode);
    }

    return this.vehicleTypeRepository.create({
      code: cleanCode,
      name: data.name.trim(),
      category: data.category || 'car',
      hasAc: data.hasAc ?? false,
      badge: data.badge ? data.badge.trim() : null,
      description: data.description ? data.description.trim() : null,
      imageUrl: data.imageUrl || null,
      imageFileId: data.imageFileId || null,
      icon: data.icon || null,
      passengerCapacity: data.passengerCapacity ?? 4,
      luggageCapacity: data.luggageCapacity ?? 2,
      displayOrder: data.displayOrder ?? 0,
      isActive: data.isActive ?? true,
    });
  }

  async updateVehicleType(
    id: string,
    data: {
      name?: string;
      category?: string;
      hasAc?: boolean;
      badge?: string | null;
      description?: string | null;
      imageUrl?: string | null;
      imageFileId?: string | null;
      icon?: string | null;
      passengerCapacity?: number | null;
      luggageCapacity?: number | null;
      displayOrder?: number;
      isActive?: boolean;
    },
  ): Promise<VehicleType> {
    const existing = await this.vehicleTypeRepository.findById(id);
    if (!existing) throw new VehicleTypeNotFoundError(id);

    return this.vehicleTypeRepository.update(id, {
      ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.hasAc !== undefined ? { hasAc: data.hasAc } : {}),
      ...(data.badge !== undefined ? { badge: data.badge ? data.badge.trim() : null } : {}),
      ...(data.description !== undefined ? { description: data.description ? data.description.trim() : null } : {}),
      ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl || null } : {}),
      ...(data.imageFileId !== undefined ? { imageFileId: data.imageFileId || null } : {}),
      ...(data.icon !== undefined ? { icon: data.icon || null } : {}),
      ...(data.passengerCapacity !== undefined ? { passengerCapacity: data.passengerCapacity } : {}),
      ...(data.luggageCapacity !== undefined ? { luggageCapacity: data.luggageCapacity } : {}),
      ...(data.displayOrder !== undefined ? { displayOrder: data.displayOrder } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    });
  }

  async toggleActive(id: string): Promise<VehicleType> {
    const existing = await this.vehicleTypeRepository.findById(id);
    if (!existing) throw new VehicleTypeNotFoundError(id);

    return this.vehicleTypeRepository.update(id, {
      isActive: !existing.isActive,
    });
  }

  async reorder(orderings: Array<{ id: string; displayOrder: number }>): Promise<void> {
    await this.vehicleTypeRepository.updateOrderings(orderings);
  }
}
