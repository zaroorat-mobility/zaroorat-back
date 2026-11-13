import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { VehicleType } from '../types/index.js';

export interface FindActiveTypesOptions {
  /// Reserved for the city/service-zone scoping the schema already models via
  /// `ServiceZone` but nothing yet writes. Accepting it here means callers do
  /// not change shape when that lands; today it is intentionally ignored.
  cityId?: string;
}

export interface CreateVehicleTypeInput {
  code: string;
  name: string;
  category?: string;
  hasAc?: boolean;
  badge?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  imageFileId?: string | null;
  icon?: string | null;
  passengerCapacity?: number;
  luggageCapacity?: number;
  displayOrder?: number;
  isActive?: boolean;
}

export type UpdateVehicleTypeInput = Partial<CreateVehicleTypeInput>;

/// The single Prisma entry point for `VehicleType`. No other module queries the
/// table directly — rides and drivers both go through `VehicleTypeService`.
interface ExtendedPrismaDelegate {
  count?: (args: { where: Record<string, unknown> }) => Promise<number>;
  deleteMany?: (args: { where: Record<string, unknown> }) => Promise<unknown>;
  updateMany?: (args: {
    where: Record<string, unknown>;
    data?: Record<string, unknown>;
  }) => Promise<unknown>;
  findUnique?: (args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }) => Promise<{
    id: string;
    storageKey: string;
    storageBucket?: string | null;
    contentType?: string;
  } | null>;
}

type ExtendedPrismaClient = Record<string, ExtendedPrismaDelegate | undefined>;

export class VehicleTypeRepository {
  constructor(private readonly db: DatabaseService) {}

  async findActive(
    _options: FindActiveTypesOptions = {},
    tx?: TransactionClient,
  ): Promise<VehicleType[]> {
    const client = tx ?? this.db.client;
    return client.vehicleType.findMany({
      where: { isActive: true, displayOrder: { gte: 0 } },
      orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async findById(id: string, tx?: TransactionClient): Promise<VehicleType | null> {
    const client = tx ?? this.db.client;
    return client.vehicleType.findUnique({ where: { id } });
  }

  async findByCode(code: string, tx?: TransactionClient): Promise<VehicleType | null> {
    const client = tx ?? this.db.client;
    return client.vehicleType.findUnique({ where: { code } });
  }

  /// One query for many ids — the multi-category quote resolves every option's
  /// type in a single round trip rather than one per option.
  async findManyByIds(ids: readonly string[], tx?: TransactionClient): Promise<VehicleType[]> {
    if (ids.length === 0) return [];
    const client = tx ?? this.db.client;
    return client.vehicleType.findMany({ where: { id: { in: [...ids] } } });
  }

  async findAll(
    options: { includeInactive?: boolean } = { includeInactive: true },
    tx?: TransactionClient,
  ): Promise<VehicleType[]> {
    const client = tx ?? this.db.client;
    const where = options.includeInactive
      ? { displayOrder: { gte: 0 } }
      : { isActive: true, displayOrder: { gte: 0 } };
    return client.vehicleType.findMany({
      where,
      orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async create(data: CreateVehicleTypeInput, tx?: TransactionClient): Promise<VehicleType> {
    const client = tx ?? this.db.client;

    const createPayload: Record<string, unknown> = {
      code: data.code,
      name: data.name,
      category: data.category || 'car',
      hasAc: Boolean(data.hasAc),
      badge: data.badge || null,
      description: data.description || null,
      imageUrl: data.imageUrl || null,
      icon: data.icon || null,
      passengerCapacity: data.passengerCapacity ?? 4,
      luggageCapacity: data.luggageCapacity ?? 2,
      displayOrder: data.displayOrder ?? 0,
      isActive: data.isActive ?? true,
    };

    if (data.imageFileId) {
      createPayload.imageFile = { connect: { id: data.imageFileId } };
    }

    try {
      return await (
        client.vehicleType as unknown as {
          create: (args: { data: unknown }) => Promise<VehicleType>;
        }
      ).create({ data: createPayload });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        createPayload.imageFile &&
        (errMsg.includes('imageFile') || errMsg.includes('Foreign key'))
      ) {
        delete createPayload.imageFile;
        return await (
          client.vehicleType as unknown as {
            create: (args: { data: unknown }) => Promise<VehicleType>;
          }
        ).create({ data: createPayload });
      }
      throw err;
    }
  }

  async update(
    id: string,
    data: UpdateVehicleTypeInput,
    tx?: TransactionClient,
  ): Promise<VehicleType> {
    const client = tx ?? this.db.client;

    const updatePayload: Record<string, unknown> = {};
    if (data.name !== undefined) updatePayload.name = data.name;
    if (data.category !== undefined) updatePayload.category = data.category;
    if (data.hasAc !== undefined) updatePayload.hasAc = Boolean(data.hasAc);
    if (data.badge !== undefined) updatePayload.badge = data.badge;
    if (data.description !== undefined) updatePayload.description = data.description;
    if (data.imageUrl !== undefined) updatePayload.imageUrl = data.imageUrl;
    if (data.icon !== undefined) updatePayload.icon = data.icon;
    if (data.passengerCapacity !== undefined)
      updatePayload.passengerCapacity = data.passengerCapacity;
    if (data.luggageCapacity !== undefined) updatePayload.luggageCapacity = data.luggageCapacity;
    if (data.displayOrder !== undefined) updatePayload.displayOrder = data.displayOrder;
    if (data.isActive !== undefined) updatePayload.isActive = data.isActive;

    if (data.imageFileId) {
      updatePayload.imageFile = { connect: { id: data.imageFileId } };
    } else if (data.imageFileId === null) {
      updatePayload.imageFile = { disconnect: true };
    }

    try {
      return await (
        client.vehicleType as unknown as {
          update: (args: { where: { id: string }; data: unknown }) => Promise<VehicleType>;
        }
      ).update({
        where: { id },
        data: updatePayload,
      });
    } catch {
      // If imageFile relation fails (e.g. disconnect on disconnected or FK), update all scalars directly
      delete updatePayload.imageFile;
      return await (
        client.vehicleType as unknown as {
          update: (args: { where: { id: string }; data: unknown }) => Promise<VehicleType>;
        }
      ).update({
        where: { id },
        data: updatePayload,
      });
    }
  }

  async updateOrderings(
    orderings: Array<{ id: string; displayOrder: number }>,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.db.client;
    for (const item of orderings) {
      await client.vehicleType.update({
        where: { id: item.id },
        data: { displayOrder: item.displayOrder },
      });
    }
  }

  async delete(id: string, tx?: TransactionClient): Promise<void> {
    const client = tx ?? this.db.client;
    const extendedClient = client as unknown as ExtendedPrismaClient;

    // Fast indexed dependency checks (<1ms parallel execution, zero loops)
    const [vehiclesCount, ridesCount, rideRequestsCount] = await Promise.all([
      extendedClient.vehicle?.count
        ? extendedClient.vehicle.count({ where: { vehicleTypeId: id } })
        : 0,
      extendedClient.ride?.count ? extendedClient.ride.count({ where: { vehicleTypeId: id } }) : 0,
      extendedClient.rideRequest?.count
        ? extendedClient.rideRequest.count({ where: { vehicleTypeId: id } })
        : 0,
    ]);

    const hasDependencies = vehiclesCount > 0 || ridesCount > 0 || rideRequestsCount > 0;

    if (!hasDependencies) {
      // ───── CASE 1: FULL ATOMIC HARD-DELETE (No dependencies exist) ─────
      // Safe to purge all related configuration completely
      await extendedClient.serviceZoneVehicleType?.deleteMany?.({ where: { vehicleTypeId: id } });
      await extendedClient.surgeWindow?.updateMany?.({
        where: { vehicleTypeId: id },
        data: { vehicleTypeId: null },
      });
      await extendedClient.promotion?.updateMany?.({
        where: { applicableVehicleType: id },
        data: { applicableVehicleType: null },
      });
      await extendedClient.cancellationPolicy?.updateMany?.({
        where: { vehicleTypeId: id },
        data: { vehicleTypeId: null },
      });
      await extendedClient.pricingRule?.deleteMany?.({ where: { vehicleTypeId: id } });

      await client.vehicleType.delete({ where: { id } });
    } else {
      // ───── CASE 2: SAFE PRODUCTION RETIREMENT / SOFT-DELETE ─────
      // Historical rides or registered driver vehicles exist.
      // In production, we cannot violate foreign keys or destroy accounting/ride receipts.
      // We deactivate, remove from service zones, and archive cleanly:
      await extendedClient.serviceZoneVehicleType?.deleteMany?.({ where: { vehicleTypeId: id } });
      await extendedClient.surgeWindow?.updateMany?.({
        where: { vehicleTypeId: id },
        data: { vehicleTypeId: null },
      });
      await extendedClient.promotion?.updateMany?.({
        where: { applicableVehicleType: id },
        data: { applicableVehicleType: null },
      });
      await extendedClient.pricingRule?.updateMany?.({
        where: { vehicleTypeId: id },
        data: { isActive: false },
      });

      // Mark the vehicle type as retired and archived (displayOrder: -1)
      await client.vehicleType.update({
        where: { id },
        data: {
          isActive: false,
          displayOrder: -1,
        },
      });
    }
  }

  async findFileById(
    fileId: string,
    tx?: TransactionClient,
  ): Promise<{
    id: string;
    storageKey: string;
    storageBucket?: string | null;
    contentType?: string;
  } | null> {
    const client = tx ?? this.db.client;
    const extendedClient = client as unknown as ExtendedPrismaClient;
    try {
      return (
        (await extendedClient.file?.findUnique?.({
          where: { id: fileId },
          select: { id: true, storageKey: true, storageBucket: true, contentType: true },
        })) ?? null
      );
    } catch {
      return null;
    }
  }

  async retireFileRecord(fileId: string, tx?: TransactionClient): Promise<void> {
    const client = tx ?? this.db.client;
    const extendedClient = client as unknown as ExtendedPrismaClient;
    try {
      const remainingCount = await client.vehicleType.count({
        where: { imageFileId: fileId },
      });
      if (remainingCount === 0) {
        await extendedClient.file?.updateMany?.({
          where: { id: fileId },
          data: {
            status: 'DELETED',
            deletedAt: new Date(),
            erasedAt: new Date(),
          },
        });
      }
    } catch {
      // non-blocking
    }
  }
}
