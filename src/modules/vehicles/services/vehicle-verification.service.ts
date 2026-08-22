import { TransactionManager } from '@core/database';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { VehicleRepository } from '../repositories/vehicle.repository.js';
import { VehicleDocumentRepository } from '../repositories/vehicle-document.repository.js';
import { VehicleEligibilityService } from './vehicle-eligibility.service.js';
import {
  SelfVehicleReviewForbiddenError,
  VehicleDocumentMismatchError,
  VehicleDocumentNotFoundError,
  VehicleDocumentsIncompleteError,
  VehicleError,
  VehicleNotFoundError,
} from '../errors/vehicle.errors.js';
import type { Vehicle, VehicleDocument, VerificationStatus } from '../types/index.js';

/// Operator review, modelled on `OnboardingService.reviewDocument` /
/// `reviewDriverVerification` — same self-review guard, same idempotent
/// no-op on an unchanged decision, same "approval requires eligibility" rule.
/// It uses the existing `VerificationStatus` enum rather than a new state
/// machine: PENDING → VERIFIED | REJECTED, and REJECTED → PENDING happens
/// implicitly when the driver re-submits a document.
export class VehicleVerificationService {
  constructor(
    private readonly vehicleRepository: VehicleRepository,
    private readonly vehicleDocumentRepository: VehicleDocumentRepository,
    private readonly vehicleEligibilityService: VehicleEligibilityService,
    private readonly driverRepository: DriverRepository,
    private readonly txManager: TransactionManager,
  ) {}

  async getForReview(vehicleId: string) {
    const vehicle = await this.vehicleRepository.findByIdWithType(vehicleId);
    if (!vehicle) throw new VehicleNotFoundError(vehicleId);
    const documents = await this.vehicleDocumentRepository.findByVehicleId(vehicleId);
    return { vehicle, documents };
  }

  private async assertNotSelfReview(vehicle: Vehicle, reviewerUserId: string): Promise<void> {
    if (!vehicle.currentDriverId) return;
    const driver = await this.driverRepository.findById(vehicle.currentDriverId);
    if (driver?.userId === reviewerUserId) throw new SelfVehicleReviewForbiddenError();
  }

  async reviewDocument(
    vehicleId: string,
    documentId: string,
    status: VerificationStatus,
    reviewerUserId: string,
    rejectionReason?: string,
  ): Promise<VehicleDocument> {
    const vehicle = await this.vehicleRepository.findById(vehicleId);
    if (!vehicle) throw new VehicleNotFoundError(vehicleId);
    await this.assertNotSelfReview(vehicle, reviewerUserId);

    const document = await this.vehicleDocumentRepository.findById(documentId);
    if (!document) throw new VehicleDocumentNotFoundError(documentId);
    if (document.vehicleId !== vehicleId) throw new VehicleDocumentMismatchError();
    if (document.verificationStatus === status) return document;

    return this.vehicleDocumentRepository.updateVerificationStatus(
      documentId,
      status,
      reviewerUserId,
      rejectionReason,
    );
  }

  async reviewVehicle(
    vehicleId: string,
    status: VerificationStatus,
    reviewerUserId: string,
    rejectionReason?: string,
  ): Promise<Vehicle> {
    const existing = await this.vehicleRepository.findById(vehicleId);
    if (!existing) throw new VehicleNotFoundError(vehicleId);
    await this.assertNotSelfReview(existing, reviewerUserId);

    return this.txManager.execute(async (tx) => {
      const locked = await this.vehicleRepository.lockForUpdate(vehicleId, tx);
      if (!locked) throw new VehicleNotFoundError(vehicleId);
      if (locked.verificationStatus === status) return locked;

      if (status === 'PENDING') {
        throw new VehicleError(
          'A review decision must be VERIFIED or REJECTED',
          'INVALID_TRANSITION',
          409,
        );
      }

      // Approval is not allowed to outrun the paperwork: the same rule
      // `reviewDriverVerification` applies before marking a driver VERIFIED.
      if (status === 'VERIFIED') {
        const documents = await this.vehicleEligibilityService.checkRequiredDocuments(
          vehicleId,
          tx,
        );
        if (!documents.eligible) {
          throw new VehicleDocumentsIncompleteError(
            'Vehicle does not meet required-document eligibility for approval',
            documents,
          );
        }
      }

      return this.vehicleRepository.updateVerificationStatus(
        vehicleId,
        status,
        reviewerUserId,
        rejectionReason,
        tx,
      );
    });
  }
}
