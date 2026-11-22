import { TransactionManager } from '@core/database';
import { FileService } from '@modules/files';
import { vehicleConfig, VEHICLE_DOCUMENT_TYPES } from '@config';
import { VehicleRepository } from '../repositories/vehicle.repository.js';
import { VehicleDocumentRepository } from '../repositories/vehicle-document.repository.js';
import { VehicleAssignmentRepository } from '../repositories/vehicle-assignment.repository.js';
import {
  UnknownVehicleDocumentTypeError,
  VehicleError,
  VehicleNotFoundError,
  VehicleNotOwnedError,
} from '../errors/vehicle.errors.js';
import type { VehicleDocument } from '../types/index.js';

export interface SubmitVehicleDocumentInput {
  vehicleId: string;
  driverId: string;
  ownerUserId: string;
  documentType: string;
  fileId: string;
  backFileId?: string;
  documentNumber?: string;
  issuedAt?: Date;
  expiresAt?: Date;
}

/// Deliberately a thin orchestration layer over the Files module: it owns *when*
/// a file may be linked to a vehicle, and nothing about how files are validated.
/// Every ownership/status/purpose rule is `FileService.assertReferenceable`'s,
/// exactly as `OnboardingService.submitDocument` uses it for driver documents.
export class VehicleDocumentService {
  constructor(
    private readonly vehicleRepository: VehicleRepository,
    private readonly vehicleDocumentRepository: VehicleDocumentRepository,
    private readonly vehicleAssignmentRepository: VehicleAssignmentRepository,
    private readonly fileService: FileService,
    private readonly txManager: TransactionManager,
  ) {}

  /// Throws `VEHICLE_NOT_FOUND` (404) when the caller holds no ACTIVE
  /// assignment on the vehicle — a 403 would confirm to a stranger that the id
  /// is real, the same reasoning the Files module's read denial follows.
  async assertManageable(vehicleId: string, driverId: string): Promise<void> {
    const vehicle = await this.vehicleRepository.findById(vehicleId);
    if (!vehicle) throw new VehicleNotFoundError(vehicleId);
    const assignment = await this.vehicleAssignmentRepository.findActiveForDriver(driverId);
    if (!assignment || assignment.vehicleId !== vehicleId) {
      throw new VehicleNotOwnedError(vehicleId);
    }
  }

  async listDocuments(vehicleId: string): Promise<VehicleDocument[]> {
    return this.vehicleDocumentRepository.findByVehicleId(vehicleId);
  }

  async submitDocument(
    input: SubmitVehicleDocumentInput,
    requestId: string | null = null,
  ): Promise<VehicleDocument> {
    if (!(VEHICLE_DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) {
      throw new UnknownVehicleDocumentTypeError(input.documentType, VEHICLE_DOCUMENT_TYPES);
    }
    await this.assertManageable(input.vehicleId, input.driverId);
    if (input.backFileId === input.fileId) {
      throw new VehicleError(
        'The back of a document must be a different file from its front',
        'DOCUMENT_BACK_IS_FRONT',
        422,
      );
    }
    // Eligibility's own `<= now` test: an already-expired document could never be approved.
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new VehicleError('This document has already expired', 'DOCUMENT_EXPIRED', 422);
    }

    const isRequired = vehicleConfig.requiredDocumentTypes.includes(input.documentType);

    return this.txManager.execute(async (tx) => {
      const existing = (
        await this.vehicleDocumentRepository.findByVehicleId(input.vehicleId, tx)
      ).find((document) => document.documentType === input.documentType);

      // Both sides locked together, in a fixed order, before either is checked.
      await this.fileService.lockForAttach(
        [input.fileId, ...(input.backFileId ? [input.backFileId] : [])],
        tx,
      );
      await this.fileService.assertReferenceable(
        input.fileId,
        input.ownerUserId,
        'VEHICLE_DOCUMENT',
        tx,
      );
      if (input.backFileId) {
        await this.fileService.assertReferenceable(
          input.backFileId,
          input.ownerUserId,
          'VEHICLE_DOCUMENT',
          tx,
        );
      }

      const created = await this.vehicleDocumentRepository.upsertDocument(
        {
          vehicleId: input.vehicleId,
          documentType: input.documentType,
          fileId: input.fileId,
          ...(input.backFileId !== undefined ? { backFileId: input.backFileId } : {}),
          ...(input.documentNumber !== undefined ? { documentNumber: input.documentNumber } : {}),
          ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        },
        tx,
      );

      // Hands the outgoing file to the retention pipeline rather than orphaning
      // it — same call `OnboardingService.submitDocument` makes on replacement.
      if (existing?.fileId && existing.fileId !== input.fileId) {
        await this.fileService.supersede(existing.fileId, input.fileId, tx, requestId);
      }
      // As for driver documents: the old back follows the new one or is retired with it.
      if (existing?.backFileId && existing.backFileId !== input.backFileId) {
        if (input.backFileId) {
          await this.fileService.supersede(existing.backFileId, input.backFileId, tx, requestId);
        } else {
          await this.fileService.releaseInTransaction(
            existing.backFileId,
            input.ownerUserId,
            tx,
            requestId,
          );
        }
      }

      // A re-submitted required document invalidates the approval the vehicle
      // already holds: the operator approved a different set of papers.
      const vehicle = await this.vehicleRepository.findById(input.vehicleId, tx);
      if (isRequired && vehicle?.verificationStatus === 'VERIFIED') {
        await this.vehicleRepository.resetVerification(input.vehicleId, tx);
      }

      // If this is VEHICLE_PHOTOS, sync the front and back photos into vehicle_images table
      if (input.documentType === 'VEHICLE_PHOTOS') {
        const existingFront = await tx.vehicleImage.findFirst({
          where: { vehicleId: input.vehicleId, imageType: 'FRONT' },
        });
        if (existingFront) {
          await tx.vehicleImage.update({
            where: { id: existingFront.id },
            data: { imageUrl: input.fileId, uploadedAt: new Date() },
          });
        } else {
          await tx.vehicleImage.create({
            data: {
              vehicleId: input.vehicleId,
              imageType: 'FRONT',
              imageUrl: input.fileId,
            },
          });
        }

        const existingExt = await tx.vehicleImage.findFirst({
          where: { vehicleId: input.vehicleId, imageType: 'EXTERIOR' },
        });
        if (existingExt) {
          await tx.vehicleImage.update({
            where: { id: existingExt.id },
            data: { imageUrl: input.fileId, uploadedAt: new Date() },
          });
        } else {
          await tx.vehicleImage.create({
            data: {
              vehicleId: input.vehicleId,
              imageType: 'EXTERIOR',
              imageUrl: input.fileId,
            },
          });
        }

        if (input.backFileId) {
          const existingBack = await tx.vehicleImage.findFirst({
            where: { vehicleId: input.vehicleId, imageType: 'BACK' },
          });
          if (existingBack) {
            await tx.vehicleImage.update({
              where: { id: existingBack.id },
              data: { imageUrl: input.backFileId, uploadedAt: new Date() },
            });
          } else {
            await tx.vehicleImage.create({
              data: {
                vehicleId: input.vehicleId,
                imageType: 'BACK',
                imageUrl: input.backFileId,
              },
            });
          }
        }
      }

      return created;
    });
  }
}
