import { TransactionManager } from '@core/database';
import { FileService } from '@modules/files';
import { vehicleConfig, VEHICLE_DOCUMENT_TYPES } from '@config';
import { VehicleRepository } from '../repositories/vehicle.repository.js';
import { VehicleDocumentRepository } from '../repositories/vehicle-document.repository.js';
import { VehicleAssignmentRepository } from '../repositories/vehicle-assignment.repository.js';
import {
  UnknownVehicleDocumentTypeError,
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

    const isRequired = vehicleConfig.requiredDocumentTypes.includes(input.documentType);

    return this.txManager.execute(async (tx) => {
      const existing = (
        await this.vehicleDocumentRepository.findByVehicleId(input.vehicleId, tx)
      ).find((document) => document.documentType === input.documentType);

      await this.fileService.assertReferenceable(
        input.fileId,
        input.ownerUserId,
        'VEHICLE_DOCUMENT',
        tx,
      );

      const created = await this.vehicleDocumentRepository.upsertDocument(
        {
          vehicleId: input.vehicleId,
          documentType: input.documentType,
          fileId: input.fileId,
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

      // A re-submitted required document invalidates the approval the vehicle
      // already holds: the operator approved a different set of papers.
      const vehicle = await this.vehicleRepository.findById(input.vehicleId, tx);
      if (isRequired && vehicle?.verificationStatus === 'VERIFIED') {
        await this.vehicleRepository.resetVerification(input.vehicleId, tx);
      }

      return created;
    });
  }
}
