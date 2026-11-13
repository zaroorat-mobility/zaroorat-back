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
import type { StorageProvider } from '@modules/files/utils/storage/storage.provider.js';
import { container } from '@core/di.js';
import { logger } from '@shared/logger/index.js';

/// The reusable lookup every other module goes through. Rides (quote, request)
/// and vehicles (claim) all validate a client-supplied `vehicleTypeId` here
/// rather than each reaching for Prisma and each inventing its own error.
export class VehicleTypeService {
  constructor(
    private readonly vehicleTypeRepository: VehicleTypeRepository,
    private readonly storageProvider?: StorageProvider,
  ) {}

  private getStorage(): StorageProvider | null {
    if (this.storageProvider) return this.storageProvider;
    try {
      if (container && container.hasRegistration('storageProvider')) {
        return container.resolve<StorageProvider>('storageProvider');
      }
    } catch {
      // Ignored if DI container is not ready
    }
    return null;
  }

  private readonly signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

  async getImageReadUrl(fileId: string): Promise<string | null> {
    const cached = this.signedUrlCache.get(fileId);
    const now = Date.now();
    if (cached && cached.expiresAt > now + 60000) {
      return cached.url;
    }

    const file = await this.vehicleTypeRepository.findFileById(fileId);
    if (!file || !file.storageKey) return null;

    const storage = this.getStorage();
    if (!storage) return null;

    try {
      const signed = await storage.signDownload({
        key: file.storageKey,
        ttlSeconds: 86400, // 24 hours validity
        contentType: file.contentType || 'image/png',
        disposition: 'inline',
        fileName: 'vehicle.png',
      });

      // Cache in memory for 12 hours (sub-millisecond instant repeat responses)
      this.signedUrlCache.set(fileId, {
        url: signed.url,
        expiresAt: now + 12 * 3600 * 1000,
      });

      return signed.url;
    } catch (err) {
      logger.warn(
        { err, fileId, storageKey: file.storageKey },
        '[VehicleType] Failed to sign image download URL',
      );
      return null;
    }
  }

  private extractFileId(str?: string | null): string | null {
    if (!str) return null;
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const match = str.match(uuidRegex);
    return match ? match[0] : null;
  }

  private async deleteStorageFile(fileId: string): Promise<void> {
    try {
      const file = await this.vehicleTypeRepository.findFileById(fileId);
      if (!file) return;

      const storage = this.getStorage();
      if (storage && file.storageKey) {
        try {
          // Erase all versions and delete markers from trusted AWS S3 bucket
          await storage.erase(file.storageKey, 'trusted');
        } catch (s3Err) {
          logger.warn(
            { err: s3Err, storageKey: file.storageKey },
            '[VehicleType] S3 trusted bucket erase failed; attempting fallback delete',
          );
          try {
            await storage.delete(file.storageKey, 'trusted');
          } catch {
            // non-blocking
          }
        }

        // Also clean up from quarantine bucket if leftover
        try {
          await storage.delete(file.storageKey, 'quarantine');
        } catch {
          // non-blocking
        }
      }

      // Mark the file record as DELETED in database
      await this.vehicleTypeRepository.retireFileRecord(fileId);
      logger.info(
        { fileId, storageKey: file?.storageKey },
        '[VehicleType] Successfully deleted vehicle image from S3 bucket and marked file DELETED',
      );
    } catch (err) {
      logger.warn(
        { err, fileId },
        '[VehicleType] Non-blocking storage file deletion encountered error',
      );
    }
  }

  private async enrichWithDirectUrls(type: VehicleType): Promise<VehicleType> {
    let resolvedImageUrl = type.imageUrl;
    let resolvedIcon = type.icon;

    // 1. Enrich imageUrl if it's a fileId or relative proxy URL
    const imageFileId = type.imageFileId || this.extractFileId(type.imageUrl);
    if (imageFileId) {
      const directS3 = await this.getImageReadUrl(imageFileId);
      if (directS3) {
        resolvedImageUrl = directS3;
      }
    }

    // 2. Enrich icon if it's a fileId or relative proxy URL
    const iconFileId = this.extractFileId(type.icon);
    if (iconFileId) {
      const directS3Icon = await this.getImageReadUrl(iconFileId);
      if (directS3Icon) {
        resolvedIcon = directS3Icon;
      }
    }

    if (resolvedImageUrl !== type.imageUrl || resolvedIcon !== type.icon) {
      return {
        ...type,
        imageUrl: resolvedImageUrl,
        icon: resolvedIcon,
      };
    }
    return type;
  }

  async listActive(options: FindActiveTypesOptions = {}): Promise<VehicleType[]> {
    const types = await this.vehicleTypeRepository.findActive(options);
    return Promise.all(types.map((type) => this.enrichWithDirectUrls(type)));
  }

  async findById(id: string): Promise<VehicleType | null> {
    const vehicleType = await this.vehicleTypeRepository.findById(id);
    return vehicleType ? this.enrichWithDirectUrls(vehicleType) : null;
  }

  /// Resolves a type and asserts it is servable. Throws
  /// `VEHICLE_TYPE_NOT_FOUND` (404) for an unknown id and
  /// `VEHICLE_TYPE_INACTIVE` (409) for a real but retired one — two distinct
  /// outcomes a client must be able to tell apart.
  async requireActive(id: string): Promise<VehicleType> {
    const vehicleType = await this.vehicleTypeRepository.findById(id);
    if (!vehicleType) throw new VehicleTypeNotFoundError(id);
    if (!vehicleType.isActive) throw new VehicleTypeInactiveError(id);
    return this.enrichWithDirectUrls(vehicleType);
  }

  async listAll(includeInactive = true): Promise<VehicleType[]> {
    const types = await this.vehicleTypeRepository.findAll({ includeInactive });
    return Promise.all(types.map((type) => this.enrichWithDirectUrls(type)));
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
      if (!existing.isActive || existing.displayOrder < 0) {
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
          displayOrder:
            data.displayOrder !== undefined && data.displayOrder >= 0 ? data.displayOrder : 0,
          isActive: true,
        });
      }
      // If already active, throw clean domain conflict error
      throw new VehicleTypeAlreadyExistsError(cleanCode);
    }

    const created = await this.vehicleTypeRepository.create({
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
    return this.enrichWithDirectUrls(created);
  }

  async updateVehicleType(
    id: string,
    data: {
      name?: string | undefined;
      category?: string | undefined;
      hasAc?: boolean | undefined;
      badge?: string | null | undefined;
      description?: string | null | undefined;
      imageUrl?: string | null | undefined;
      imageFileId?: string | null | undefined;
      icon?: string | null | undefined;
      passengerCapacity?: number | null | undefined;
      luggageCapacity?: number | null | undefined;
      displayOrder?: number | undefined;
      isActive?: boolean | undefined;
    },
  ): Promise<VehicleType> {
    const existing = await this.vehicleTypeRepository.findById(id);
    if (!existing) throw new VehicleTypeNotFoundError(id);

    // If image file was replaced, delete old file from AWS S3 storage bucket
    if (
      data.imageFileId !== undefined &&
      data.imageFileId !== existing.imageFileId &&
      existing.imageFileId
    ) {
      void this.deleteStorageFile(existing.imageFileId);
    }

    const updated = await this.vehicleTypeRepository.update(id, {
      ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.hasAc !== undefined ? { hasAc: data.hasAc } : {}),
      ...(data.badge !== undefined ? { badge: data.badge ? data.badge.trim() : null } : {}),
      ...(data.description !== undefined
        ? { description: data.description ? data.description.trim() : null }
        : {}),
      ...(data.imageUrl !== undefined ? { imageUrl: data.imageUrl || null } : {}),
      ...(data.imageFileId !== undefined ? { imageFileId: data.imageFileId || null } : {}),
      ...(data.icon !== undefined ? { icon: data.icon || null } : {}),
      ...(data.passengerCapacity !== undefined
        ? { passengerCapacity: data.passengerCapacity }
        : {}),
      ...(data.luggageCapacity !== undefined ? { luggageCapacity: data.luggageCapacity } : {}),
      ...(data.displayOrder !== undefined ? { displayOrder: data.displayOrder } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    });
    return this.enrichWithDirectUrls(updated);
  }

  async toggleActive(id: string): Promise<VehicleType> {
    const existing = await this.vehicleTypeRepository.findById(id);
    if (!existing) throw new VehicleTypeNotFoundError(id);

    const updated = await this.vehicleTypeRepository.update(id, {
      isActive: !existing.isActive,
    });
    return this.enrichWithDirectUrls(updated);
  }

  async reorder(orderings: Array<{ id: string; displayOrder: number }>): Promise<void> {
    await this.vehicleTypeRepository.updateOrderings(orderings);
  }

  async deleteVehicleType(id: string): Promise<void> {
    const existing = await this.vehicleTypeRepository.findById(id);
    if (!existing) throw new VehicleTypeNotFoundError(id);

    // 1. Collect all attached file IDs before removing vehicleType
    const fileIdsToDelete: string[] = [];
    if (existing.imageFileId) {
      fileIdsToDelete.push(existing.imageFileId);
    } else {
      const urlFileId = this.extractFileId(existing.imageUrl);
      if (urlFileId) fileIdsToDelete.push(urlFileId);
    }

    const iconFileId = this.extractFileId(existing.icon);
    if (iconFileId && !fileIdsToDelete.includes(iconFileId)) {
      fileIdsToDelete.push(iconFileId);
    }

    // 2. Delete / decommission vehicle service record in database
    await this.vehicleTypeRepository.delete(id);

    // 3. Delete image files from AWS S3 storage bucket and mark them DELETED
    for (const fileId of fileIdsToDelete) {
      await this.deleteStorageFile(fileId);
    }
  }
}
