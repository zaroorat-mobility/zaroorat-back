import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverDocumentRepository } from '../../repositories/driver-document.repository.js';
import { DriverNotFoundError } from '../../errors/driver.errors.js';
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

  async submitDocument(data: {
    driverId: string;
    documentType: DriverDocumentType;
    fileUrl: string;
    documentNumber?: string;
    expiresAt?: Date;
  }): Promise<DriverDocument> {
    const driver = await this.driverRepo.findById(data.driverId);
    if (!driver) throw new DriverNotFoundError(data.driverId);

    return this.txManager.execute(async (tx) => {
      const doc = await this.docRepo.upsertDocument(data, tx);

      if (driver.verificationStatus === 'PENDING') {
        await this.driverRepo.updateVerificationStatus(
          data.driverId,
          'DOCUMENT_REVIEW',
          undefined,
          undefined,
          tx,
        );
      }

      return doc;
    });
  }

  async reviewDriverVerification(
    driverId: string,
    status: VerificationStatus,
    approvedBy?: string,
    rejectionReason?: string,
  ): Promise<Driver> {
    const driver = await this.driverRepo.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);

    return this.txManager.execute(async (tx) => {
      await this.driverRepo.lockForUpdate(driverId, tx);

      const newVerificationStatus: DriverVerificationStatus =
        status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED';

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
          }),
          tx,
        );
      }

      return updated;
    });
  }
}
