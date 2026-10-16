import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import { recordAdminAction, type AuditActor } from '@modules/admin/audit/index.js';
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
      const updated = await this.driverRepo.updateProfile(userId, driverId, data, tx);
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.PROFILE_UPDATED, driverId, {
          driverId,
          userId,
        }),
        tx,
      );
      return updated;
    });
  }

  async reviewDriverVerification(
    driverId: string,
    status: VerificationStatus,
    actor: AuditActor,
    rejectionReason?: string,
  ): Promise<Driver> {
    return this.txManager.execute((tx) =>
      this.reviewDriverVerificationInTransaction(driverId, status, actor, rejectionReason, tx),
    );
  }

  /// "Send back for corrections". The driver returns to PENDING — waiting on their
  /// documents — carrying the operator's reason, the instructions the driver app shows; the
  /// admin queue reads PENDING-with-instructions as "resubmission required". Their next
  /// upload moves them to DOCUMENT_REVIEW. A final rejection is REJECTED instead, which an
  /// upload never leaves. The change is recorded as its own decision
  /// (`decision: 'RESUBMISSION_REQUESTED'`, summary "Driver Resubmission Requested"), never
  /// as a REJECT, which is a different operator act.
  ///
  /// The same instructions again, while the driver has not yet re-uploaded, change nothing
  /// and are refused (`RESUBMISSION_ALREADY_REQUESTED`), so it cannot log a success that did
  /// not happen. A SUSPENDED driver cannot be sent back. The driver row is locked first, so
  /// concurrent requests serialise and the second sees the first's result.
  async requestResubmission(driverId: string, actor: AuditActor, reason: string): Promise<Driver> {
    return this.txManager.execute(async (tx) => {
      const locked = await this.driverRepo.lockForUpdate(driverId, tx);
      if (!locked) throw new DriverNotFoundError(driverId);
      if (locked.userId === actor.actorId) throw new SelfReviewForbiddenError();

      const resubmittable: DriverVerificationStatus[] = [
        'PENDING',
        'DOCUMENT_REVIEW',
        'VERIFIED',
        'REJECTED',
      ];
      if (!resubmittable.includes(locked.verificationStatus)) {
        throw new DriverError(
          `Cannot request resubmission from '${locked.verificationStatus}'`,
          'INVALID_TRANSITION',
          409,
        );
      }
      if (locked.verificationStatus === 'PENDING' && locked.rejectionReason === reason) {
        throw new DriverError(
          'Resubmission has already been requested with these instructions',
          'RESUBMISSION_ALREADY_REQUESTED',
          409,
        );
      }

      const updated = await this.driverRepo.updateVerificationStatus(
        driverId,
        'PENDING',
        actor.actorId,
        reason,
        tx,
      );
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'driver',
        entityId: driverId,
        summary: 'Driver Resubmission Requested',
        notes: reason,
        before: {
          verificationStatus: locked.verificationStatus,
          rejectionReason: locked.rejectionReason,
        },
        after: {
          verificationStatus: updated.verificationStatus,
          rejectionReason: updated.rejectionReason,
          decision: 'RESUBMISSION_REQUESTED',
        },
        result: 'SUCCESS',
      });
      // The driver's SMS rides on this event: it commits with the decision and its audit
      // row, and is sent only once the outbox relay delivers it after commit.
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.RESUBMISSION_REQUESTED, driverId, {
          driverId,
          userId: locked.userId,
          reason,
        }),
        tx,
      );
      return updated;
    });
  }

  /// The decision and its audit row commit together, inside the caller's transaction
  /// (application approval also promotes documents and the vehicle in it). A repeated
  /// decision changes nothing and is not logged again. The row carries statuses and the
  /// operator's reason only — never document numbers or file locations.
  async reviewDriverVerificationInTransaction(
    driverId: string,
    status: VerificationStatus,
    actor: AuditActor,
    rejectionReason: string | undefined,
    tx: TransactionClient,
  ): Promise<Driver> {
    const approvedBy = actor.actorId;
    const locked = await this.driverRepo.lockForUpdate(driverId, tx);
    if (!locked) throw new DriverNotFoundError(driverId);
    if (locked.userId === approvedBy) throw new SelfReviewForbiddenError();

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

    // Each decision's event commits with it and its audit row; the driver's SMS is sent
    // from the event only after commit, so a rolled-back decision never texts anyone.
    if (newVerificationStatus === 'VERIFIED') {
      this.driverMetrics.driverVerified({ driverId });
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.VERIFIED, driverId, {
          driverId,
          approvedBy,
          userId: locked.userId,
        }),
        tx,
      );
    } else {
      await this.eventPublisher.publish(
        driverEvent(DRIVER_EVENT_CATALOG.VERIFICATION_REJECTED, driverId, {
          driverId,
          rejectedBy: approvedBy,
          userId: locked.userId,
          ...(rejectionReason ? { reason: rejectionReason } : {}),
        }),
        tx,
      );
    }

    await recordAdminAction(tx, {
      ...actor,
      action: newVerificationStatus === 'VERIFIED' ? 'APPROVE' : 'REJECT',
      entityType: 'driver',
      entityId: driverId,
      summary:
        newVerificationStatus === 'VERIFIED'
          ? 'Driver Verification Approved'
          : 'Driver Verification Rejected',
      notes: rejectionReason,
      before: { verificationStatus: locked.verificationStatus },
      after: { verificationStatus: updated.verificationStatus },
      result: 'SUCCESS',
    });
    return updated;
  }
}
