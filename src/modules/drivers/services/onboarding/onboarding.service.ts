import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { FileService } from '@modules/files';
import { driverConfig } from '@config';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverDocumentRepository } from '../../repositories/driver-document.repository.js';
import { DriverStatusRepository } from '../../repositories/driver-status.repository.js';
import { StatusService } from '../status/status.service.js';
import { DriverEligibilityService } from '../eligibility/eligibility.service.js';
import {
  DriverError,
  DriverNotFoundError,
  DocumentValidationError,
  SelfReviewForbiddenError,
} from '../../errors/driver.errors.js';
import { driverEvent, DRIVER_EVENT_CATALOG } from '../../events/catalog.js';
import { DriverMetrics } from '../../metrics/driver.metrics.js';
import type {
  Driver,
  DriverDocument,
  DriverDocumentType,
  DriverVerificationStatus,
  VerificationStatus,
} from '../../types';
export class OnboardingService {
  constructor(
    private readonly driverRepo: DriverRepository,
    private readonly docRepo: DriverDocumentRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly driverMetrics: DriverMetrics,
    private readonly fileService: FileService,
    private readonly eligibilityService: DriverEligibilityService,
    private readonly statusRepo: DriverStatusRepository,
    private readonly statusService: StatusService,
  ) {}
  async createOrGetDriver(userId: string): Promise<Driver> {
    const existing = await this.driverRepo.findByUserId(userId);
    if (existing) return existing;
    return this.txManager.execute(async (tx) => {
      const created = await this.driverRepo.createDriver(userId, tx);
      this.driverMetrics.driverRegistered({ driverId: created.id, userId });
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.ONBOARDED, created.id, {
          driverId: created.id,
          userId,
        }),
        tx,
      );
      return created;
    });
  }
  async updateProfile(driverId: string, data: Parameters<DriverRepository['updateProfile']>[1]) {
    const driver = await this.driverRepo.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);
    return this.driverRepo.updateProfile(driverId, data);
  }
  async submitDocument(
    data: {
      driverId: string;
      documentType: DriverDocumentType;
      fileId: string;
      documentNumber?: string;
      expiresAt?: Date;
    },
    requestId: string | null = null,
  ): Promise<DriverDocument> {
    const driver = await this.driverRepo.findById(data.driverId);
    if (!driver) throw new DriverNotFoundError(data.driverId);
    const isRequired = (driverConfig.requiredDocumentTypes as string[]).includes(data.documentType);
    const wasVerifiedRequiredResubmit = driver.verificationStatus === 'VERIFIED' && isRequired;
    const doc = await this.txManager.execute(async (tx) => {
      const existing = (await this.docRepo.findByDriverId(data.driverId, tx)).find(
        (d) => d.documentType === data.documentType,
      );
      await this.fileService.assertReferenceable(data.fileId, driver.userId, 'DRIVER_DOCUMENT', tx);
      const created = await this.docRepo.upsertDocument(data, tx);
      if (existing?.fileId && existing.fileId !== data.fileId) {
        await this.fileService.supersede(existing.fileId, data.fileId, tx, requestId);
      }
      if (driver.verificationStatus === 'PENDING') {
        await this.driverRepo.updateVerificationStatus(
          data.driverId,
          'DOCUMENT_REVIEW',
          undefined,
          undefined,
          tx,
        );
      } else if (wasVerifiedRequiredResubmit) {
        await this.driverRepo.updateVerificationStatus(
          data.driverId,
          'DOCUMENT_REVIEW',
          undefined,
          'Required document re-submitted',
          tx,
        );
      }
      return created;
    });
    if (wasVerifiedRequiredResubmit) {
      const currentStatus = await this.statusRepo.getStatus(data.driverId);
      if (currentStatus?.status === 'ONLINE' || currentStatus?.status === 'BREAK') {
        await this.statusService.setOffline(data.driverId, 'DOCUMENT_RESUBMITTED');
      }
    }
    return doc;
  }
  async reviewDocument(
    documentId: string,
    driverId: string,
    status: VerificationStatus,
    reviewerId: string,
    rejectionReason?: string,
  ): Promise<DriverDocument> {
    const driver = await this.driverRepo.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);
    if (driver.userId === reviewerId) throw new SelfReviewForbiddenError();
    const doc = await this.docRepo.findById(documentId);
    if (!doc) {
      throw new DriverError(`Document '${documentId}' was not found`, 'DOCUMENT_NOT_FOUND', 404);
    }
    if (doc.driverId !== driverId) {
      throw new DriverError(
        'Document does not belong to the specified driver',
        'DOCUMENT_DRIVER_MISMATCH',
        409,
      );
    }
    if (doc.verificationStatus === status) {
      return doc;
    }
    const reviewed = await this.docRepo.updateVerificationStatus(
      documentId,
      status,
      reviewerId,
      rejectionReason,
    );
    if (status === 'VERIFIED') {
      this.driverMetrics.documentVerified({ documentId, driverId });
    } else {
      this.driverMetrics.documentRejected({ documentId, driverId });
    }
    return reviewed;
  }
  async reviewDriverVerification(
    driverId: string,
    status: VerificationStatus,
    approvedBy: string,
    rejectionReason?: string,
  ): Promise<Driver> {
    const driver = await this.driverRepo.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);
    if (driver.userId === approvedBy) throw new SelfReviewForbiddenError();
    return this.txManager.execute(async (tx) => {
      const locked = await this.driverRepo.lockForUpdate(driverId, tx);
      if (!locked) throw new DriverNotFoundError(driverId);
      const newVerificationStatus: DriverVerificationStatus =
        status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED';
      if (locked.verificationStatus === newVerificationStatus) {
        return locked;
      }
      const allowedSources: DriverVerificationStatus[] =
        newVerificationStatus === 'VERIFIED'
          ? ['PENDING', 'DOCUMENT_REVIEW', 'REJECTED']
          : ['PENDING', 'DOCUMENT_REVIEW', 'VERIFIED'];
      if (!allowedSources.includes(locked.verificationStatus)) {
        throw new DriverError(
          `Cannot transition driver from '${locked.verificationStatus}' to '${newVerificationStatus}'`,
          'INVALID_TRANSITION',
          409,
        );
      }
      if (newVerificationStatus === 'VERIFIED') {
        const eligibility = await this.eligibilityService.checkRequiredDocuments(driverId, tx);
        if (!eligibility.eligible) {
          throw new DocumentValidationError(
            'Driver does not meet required-document eligibility for approval',
            eligibility,
          );
        }
      }
      const updated = await this.driverRepo.updateVerificationStatus(
        driverId,
        newVerificationStatus,
        approvedBy,
        rejectionReason,
        tx,
      );
      if (newVerificationStatus === 'VERIFIED') {
        this.driverMetrics.driverVerified({ driverId });
        await this.eventPublisher.publish(
          driverEvent(DRIVER_EVENT_CATALOG.VERIFIED, driverId, {
            driverId,
            approvedBy,
            userId: driver.userId,
          }),
          tx,
        );
      }
      return updated;
    });
  }
}
