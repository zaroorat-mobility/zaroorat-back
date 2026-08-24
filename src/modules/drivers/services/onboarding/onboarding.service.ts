import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverEligibilityService } from '../eligibility/eligibility.service.js';
import {
  DriverError,
  DriverNotFoundError,
  DocumentValidationError,
  SelfReviewForbiddenError,
} from '../../errors/driver.errors.js';
import { driverEvent, DRIVER_EVENT_CATALOG } from '../../events/catalog.js';
import { DriverMetrics } from '../../metrics/driver.metrics.js';
import type { Driver, DriverVerificationStatus, VerificationStatus } from '../../types';

export class OnboardingService {
  constructor(
    private readonly driverRepo: DriverRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly driverMetrics: DriverMetrics,
    private readonly eligibilityService: DriverEligibilityService,
  ) {}

  async onboardDriver(userId: string): Promise<Driver> {
    const existing = await this.driverRepo.findByUserId(userId);
    if (existing) return existing;

    try {
      return await this.txManager.execute(async (tx) => {
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
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        const raceConditionDriver = await this.driverRepo.findByUserId(userId);
        if (raceConditionDriver) return raceConditionDriver;
      }
      throw err;
    }
  }

  async updateProfile(
    userId: string,
    driverId: string,
    data: Parameters<DriverRepository['updateProfile']>[2],
  ) {
    const driver = await this.driverRepo.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);

    return this.txManager.execute(async (tx) => {
      return this.driverRepo.updateProfile(userId, driverId, data, tx);
    });
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
