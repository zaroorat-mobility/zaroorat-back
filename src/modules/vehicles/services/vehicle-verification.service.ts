import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { lockForAudit, recordAdminAction, type AuditActor } from '@modules/admin/audit/index.js';
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

  private async assertNotSelfReview(
    vehicle: Vehicle,
    reviewerUserId: string,
    tx: TransactionClient,
  ): Promise<void> {
    if (!vehicle.currentDriverId) return;
    const driver = await this.driverRepository.findById(vehicle.currentDriverId, tx);
    if (driver?.userId === reviewerUserId) throw new SelfVehicleReviewForbiddenError();
  }

  /// The decision and its audit row commit together, under a lock on the document row
  /// taken before its status is read: two concurrent reviews cannot both pass the "already
  /// in this status" check and log twice. A repeated decision changes and logs nothing.
  /// The row carries the document's type and statuses — never its number, file or URL.
  async reviewDocument(
    vehicleId: string,
    documentId: string,
    status: VerificationStatus,
    actor: AuditActor,
    rejectionReason?: string,
  ): Promise<VehicleDocument> {
    return this.txManager.execute(async (tx) => {
      const vehicle = await this.vehicleRepository.findById(vehicleId, tx);
      if (!vehicle) throw new VehicleNotFoundError(vehicleId);
      await this.assertNotSelfReview(vehicle, actor.actorId, tx);

      await lockForAudit(tx, 'vehicle_documents', documentId);
      const document = await this.vehicleDocumentRepository.findById(documentId, tx);
      if (!document) throw new VehicleDocumentNotFoundError(documentId);
      if (document.vehicleId !== vehicleId) throw new VehicleDocumentMismatchError();
      if (document.verificationStatus === status) return document;

      const reviewed = await this.vehicleDocumentRepository.updateVerificationStatus(
        documentId,
        status,
        actor.actorId,
        rejectionReason,
        tx,
      );
      await recordAdminAction(tx, {
        ...actor,
        action: status === 'VERIFIED' ? 'APPROVE' : 'REJECT',
        entityType: 'vehicle_document',
        entityId: documentId,
        summary: `Vehicle document ${document.documentType} ${status === 'VERIFIED' ? 'verified' : 'rejected'}`,
        notes: rejectionReason,
        before: { verificationStatus: document.verificationStatus },
        after: {
          verificationStatus: reviewed.verificationStatus,
          vehicleId,
          documentType: document.documentType,
        },
        result: 'SUCCESS',
      });
      return reviewed;
    });
  }

  /// Same shape as the document review: the vehicle row is locked before its status is
  /// read, and the decision commits with its APPROVE/REJECT row or not at all.
  async reviewVehicle(
    vehicleId: string,
    status: VerificationStatus,
    actor: AuditActor,
    rejectionReason?: string,
  ): Promise<Vehicle> {
    return this.txManager.execute(async (tx) => {
      const locked = await this.vehicleRepository.lockForUpdate(vehicleId, tx);
      if (!locked) throw new VehicleNotFoundError(vehicleId);
      await this.assertNotSelfReview(locked, actor.actorId, tx);
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

      const updated = await this.vehicleRepository.updateVerificationStatus(
        vehicleId,
        status,
        actor.actorId,
        rejectionReason,
        tx,
      );
      await recordAdminAction(tx, {
        ...actor,
        action: status === 'VERIFIED' ? 'APPROVE' : 'REJECT',
        entityType: 'vehicle',
        entityId: vehicleId,
        summary:
          status === 'VERIFIED' ? 'Vehicle Verification Approved' : 'Vehicle Verification Rejected',
        notes: rejectionReason,
        before: { verificationStatus: locked.verificationStatus },
        after: { verificationStatus: updated.verificationStatus },
        result: 'SUCCESS',
      });
      return updated;
    });
  }
}
